import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { evidence } from './contract-helpers.mjs';
import { admin, fixture, json, jsonCall } from './http-helpers.mjs';

// Discover persisted JSON by its known synthetic queue identity, never by an
// assumed filename, nesting layout, or private message/receipt schema.
async function stateFiles(root, marker) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...await stateFiles(path, marker));
    else if (entry.isFile()) {
      const text = await readFile(path, 'utf8');
      try { if (JSON.stringify(JSON.parse(text)).includes(marker)) found.push(path); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    }
  }
  return found;
}

test(evidence(['sqs.GetQueueUrl', 'sqs.ReceiveMessage', 'sqs.DeleteMessage'], 'lifecycle', 'save and reopen preserve bodies delay visibility current and old receipts with a new advertised origin'), { timeout: 18000 }, async (t) => {
  const f = await fixture(t);
  let server = await f.start({ endpoint: 'http://127.0.0.1:49120' });
  const oldUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'old-receipt' })).QueueUrl;
  json(await jsonCall(server, 'SendMessage', { QueueUrl: oldUrl, MessageBody: 'old receipt survivor' }));
  const old = json(await jsonCall(server, 'ReceiveMessage', { QueueUrl: oldUrl, VisibilityTimeout: 0 })).Messages[0];
  const newer = json(await jsonCall(server, 'ReceiveMessage', { QueueUrl: oldUrl, VisibilityTimeout: 0 })).Messages[0];
  const currentUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'current-receipt' })).QueueUrl;
  json(await jsonCall(server, 'SendMessage', { QueueUrl: currentUrl, MessageBody: 'hidden current receipt' }));
  const current = json(await jsonCall(server, 'ReceiveMessage', { QueueUrl: currentUrl, VisibilityTimeout: 43200 })).Messages[0];
  const delayedUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'delayed', Attributes: { DelaySeconds: '900' } })).QueueUrl;
  json(await jsonCall(server, 'SendMessage', { QueueUrl: delayedUrl, MessageBody: 'persisted delayed body' }));
  assert.deepEqual(json(await admin(server, '/save', { method: 'POST', body: '{}' })), { saved: true });
  await server.close();
  server = await f.start({ endpoint: 'http://127.0.0.1:49121' });
  const QueueUrl = json(await jsonCall(server, 'GetQueueUrl', { QueueName: 'old-receipt' })).QueueUrl;
  assert.equal(QueueUrl, 'http://127.0.0.1:49121/000000000000/us-east-1/old-receipt');
  assert.equal((await jsonCall(server, 'DeleteMessage', { QueueUrl, ReceiptHandle: old.ReceiptHandle })).status, 200);
  const survivor = json(await jsonCall(server, 'ReceiveMessage', { QueueUrl })).Messages[0];
  assert.equal(survivor.MessageId, newer.MessageId);
  assert.equal(survivor.Body, 'old receipt survivor');
  assert.notEqual(survivor.ReceiptHandle, newer.ReceiptHandle);
  const currentLocal = json(await jsonCall(server, 'GetQueueUrl', { QueueName: 'current-receipt' })).QueueUrl;
  assert.deepEqual(json(await jsonCall(server, 'ReceiveMessage', { QueueUrl: currentLocal })), {});
  const deleted = await jsonCall(server, 'DeleteMessage', { QueueUrl: currentLocal, ReceiptHandle: current.ReceiptHandle });
  assert.equal(deleted.status, 200, deleted.text);
  assert.equal(deleted.bytes, 0);
  const delayedLocal = json(await jsonCall(server, 'GetQueueUrl', { QueueName: 'delayed' })).QueueUrl;
  assert.deepEqual(json(await jsonCall(server, 'ReceiveMessage', { QueueUrl: delayedLocal })), {});
});

test(evidence(['sqs.GetQueueUrl', 'sqs.ReceiveMessage'], 'lifecycle', 'close flushes unsaved dirty queues and payloads before releasing the lock'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  let server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'unsaved-before-close' })).QueueUrl;
  json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'flush on close' }));
  await server.close();
  server = await f.start();
  const local = json(await jsonCall(server, 'GetQueueUrl', { QueueName: 'unsaved-before-close' })).QueueUrl;
  assert.equal(json(await jsonCall(server, 'ReceiveMessage', { QueueUrl: local })).Messages[0].Body, 'flush on close');
});

test('state directory allows one live owner and failed acquisition does not disrupt that owner', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const first = await f.start();
  await assert.rejects(() => f.start(), /lock|owner|already|in use/iu);
  assert.equal(json(await admin(first, '/health')).status, 'running');
  await first.close();
  const second = await f.start();
  assert.equal(json(await admin(second, '/health')).status, 'running');
});

test('corrupt persisted JSON fails startup without silently resetting or rewriting the evidence', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  json(await jsonCall(server, 'CreateQueue', { QueueName: 'Persistent_queue_marker' }));
  await server.close();
  const files = await stateFiles(f.stateDirectory, 'Persistent_queue_marker');
  assert.ok(files.length > 0, 'versioned JSON must retain the queue identity');
  const [file] = files;
  await writeFile(file, '{corrupt-synthetic-state', 'utf8');
  await assert.rejects(() => f.start(), /state|json|corrupt|pars|invalid/iu);
  assert.equal(await readFile(file, 'utf8'), '{corrupt-synthetic-state');
});

test('symlink or junction state roots are rejected before acquiring ownership', { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const target = join(f.root, 'real-state');
  const linked = join(f.root, 'linked-state');
  await mkdir(target);
  await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => f.start({ stateDirectory: linked }), /link|junction|state|real|directory/iu);
  const normal = await f.start({ stateDirectory: target });
  assert.equal(json(await admin(normal, '/health')).status, 'running');
});

test('linked state files are rejected without following or rewriting their outside target', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  json(await jsonCall(server, 'CreateQueue', { QueueName: 'Linked_state_marker' }));
  await server.close();
  const files = await stateFiles(f.stateDirectory, 'Linked_state_marker');
  assert.ok(files.length > 0);
  const [file] = files;
  const original = await readFile(file, 'utf8');
  const outside = join(f.root, 'outside-state.json');
  await rename(file, outside);
  try { await symlink(outside, file, 'file'); }
  catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    await rename(outside, file);
    t.skip(`host cannot create file symlinks: ${error.code}; no evidence credited`);
    return;
  }
  await assert.rejects(() => f.start(), /link|state|real|file/iu);
  assert.equal(await readFile(outside, 'utf8'), original);
});
