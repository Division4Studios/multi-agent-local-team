import assert from 'node:assert/strict';
import { link, lstat, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { context, evidence, sqsHarness, stsBackend } from './contract-helpers.mjs';
import { admin, fixture, json, jsonCall } from './http-helpers.mjs';
import { cloneDocument, delivered, durableState, invalidStateCases, liveStateFixture,
  portableDocument, stateScope } from './state-integrity-fixtures.mjs';

for (const [label, mutate] of invalidStateCases) {
  test(evidence(['sqs.DeleteMessage', 'sqs.ReceiveMessage'], 'lifecycle', `state v1 rejects ${label} atomically`), { timeout: 5000 }, async () => {
    const { h, QueueUrl, current, original, neighbor, otherState } = await liveStateFixture();
    const invalid = cloneDocument(original);
    delivered(invalid).body = 'valid replacement that must never be installed';
    mutate(invalid);
    assert.throws(() => h.backend.importState(stateScope, invalid), label);
    assert.deepEqual(h.backend.exportState(stateScope), original, label);
    assert.deepEqual(h.backend.exportState(neighbor), otherState, `${label}: neighboring scope`);
    await h.call('DeleteMessage', { QueueUrl, ReceiptHandle: current.ReceiptHandle });
    const result = await h.call('ReceiveMessage', { QueueUrl, MaxNumberOfMessages: 10 });
    assert.deepEqual(result.Messages.map(({ Body }) => Body), ['original available body']);
  });
}

test(evidence(['sqs.GetQueueUrl', 'sqs.ReceiveMessage'], 'lifecycle', 'portable v1 permits future clocks visibility beyond retention and queue-scoped opaque identities'), async () => {
  const h = sqsHarness();
  const document = portableDocument();
  const q = document.data.queues[0];
  q.attributes.MessageRetentionPeriod = '60';
  const m = q.messages[0];
  Object.assign(m, { id: 'm'.repeat(2048), sentAt: h.now() + 5000, availableAt: h.now() + 125000,
    expiresAt: h.now() + 65000, receiveCount: 1, firstReceivedAt: h.now() + 5001, currentReceipt: 'r'.repeat(2048) });
  document.data.queues.push({ ...cloneDocument(q), name: 'OtherPortable' });
  h.backend.importState(stateScope, document);
  const exported = h.backend.exportState(stateScope);
  for (const name of ['Portable', 'OtherPortable']) {
    const imported = exported.data.queues.find((item) => item.name === name);
    assert.deepEqual(imported.messages, [m]);
    const { QueueUrl } = await h.call('GetQueueUrl', { QueueName: name });
    assert.deepEqual(await h.call('ReceiveMessage', { QueueUrl }), {});
  }
  h.advance(65000);
  const { QueueUrl } = await h.call('GetQueueUrl', { QueueName: 'Portable' });
  assert.deepEqual(await h.call('ReceiveMessage', { QueueUrl }), {});
  assert.deepEqual(h.backend.exportState(stateScope).data.queues.find(({ name }) => name === 'Portable').messages, []);
});

test(evidence(['sts.GetCallerIdentity'], 'lifecycle', 'STS v1 accepts only empty mutable data and rejects extra envelope fields atomically'), async () => {
  const backend = stsBackend();
  const valid = { formatVersion: 1, service: 'sts', scope: { ...stateScope }, data: {} };
  backend.importState(stateScope, valid);
  assert.deepEqual(backend.exportState(stateScope), valid);
  for (const invalid of [
    { ...valid, data: null }, { ...valid, data: [] }, { ...valid, data: { queues: [] } },
    { ...valid, endpoint: 'http://outside.invalid' }, { ...valid, formatVersion: 2 },
    { ...valid, scope: { ...stateScope, account: '111122223333' } },
  ]) {
    assert.throws(() => backend.importState(stateScope, invalid));
    assert.deepEqual(backend.exportState(stateScope), valid);
  }
  assert.deepEqual(await backend.handle({ operation: 'GetCallerIdentity', input: {} }, context()), {
    Account: '000000000000', Arn: 'arn:aws:iam::000000000000:root', UserId: '000000000000',
  });
});

const badDiskCases = [
  ['future envelope version', (s) => { s.formatVersion = 2; }],
  ['future service version', (s) => { s.documents[0].formatVersion = 2; }],
  ['unknown service', (s) => { s.documents[0].service = 'future-service'; }],
  ['duplicate service/account/region tuple', (s) => { s.documents.push(cloneDocument(s.documents[0])); }],
  ['unknown disk field', (s) => { s.path = '../outside'; }],
  ['invalid nested message relationship', (s) => { s.documents[0].data.queues[0].messages[0].expiresAt += 1; }],
];
for (const [label, mutate] of badDiskCases) {
  test(`state.json rejects ${label} without rewriting it or retaining an owned lock`, { timeout: 12000 }, async (t) => {
    const f = await fixture(t);
    await mkdir(f.stateDirectory);
    const state = { formatVersion: 1, documents: [portableDocument()] };
    mutate(state);
    const bytes = `${JSON.stringify(state)}\n`;
    const path = join(f.stateDirectory, 'state.json');
    await writeFile(path, bytes);
    await assert.rejects(() => f.start(), /state|version|service|invalid|duplicate|document/iu);
    assert.equal(await readFile(path, 'utf8'), bytes);
    await assert.rejects(() => stat(join(f.stateDirectory, '.lock')), { code: 'ENOENT' });
  });
}

test('an old pre-existing .lock remains byte-for-byte owned by its creator after refused startup', { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(f.stateDirectory);
  const path = join(f.stateDirectory, '.lock');
  const owner = 'synthetic-other-owner-do-not-delete\n';
  await writeFile(path, owner, { flag: 'wx' });
  await utimes(path, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
  const before = await stat(path);
  await assert.rejects(() => f.start(), /lock|owner|already|in use/iu);
  assert.equal(await readFile(path, 'utf8'), owner);
  const after = await stat(path);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);
});

test(evidence(['sqs.CreateQueue', 'sqs.SendMessage'], 'lifecycle', 'dirty timer makes the completed mutation durable within four seconds without save or close'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'TimerDurability' })).QueueUrl;
  const sent = json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'timer-only-payload' }));
  const state = await durableState(join(f.stateDirectory, 'state.json'), (value) => value.documents.some((document) =>
    document.service === 'sqs' && document.data.queues.some((q) => q.name === 'TimerDurability'
      && q.messages.some((m) => m.id === sent.MessageId && m.body === 'timer-only-payload'))));
  assert.equal(state.formatVersion, 1);
  const document = state.documents.find((item) => item.service === 'sqs');
  assert.deepEqual(document.scope, stateScope);
  const [message] = document.data.queues.find(({ name }) => name === 'TimerDurability').messages;
  assert.equal(message.receiveCount, 0);
  assert.equal(message.expiresAt - message.sentAt, 345600000);
  assert.equal(json(await admin(server, '/health')).status, 'running');
});

test('a hardlinked state.json is rejected before startup can read or replace its outside inode', { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  await mkdir(f.stateDirectory);
  const outside = join(f.root, 'outside-state.json');
  const bytes = JSON.stringify({ formatVersion: 1, documents: [portableDocument()] });
  await writeFile(outside, bytes);
  const path = join(f.stateDirectory, 'state.json');
  await link(outside, path);
  await assert.rejects(() => f.start(), /link|state|file/iu);
  assert.equal(await readFile(outside, 'utf8'), bytes);
  assert.equal((await stat(outside)).nlink, 2);
  assert.equal((await stat(path)).ino, (await stat(outside)).ino);
});

for (const kind of ['hardlink', 'symlink']) {
  test(evidence(['sqs.SendMessage'], 'lifecycle', `${kind} write failure preserves outside bytes and retries dirty state after destination repair`), { timeout: 18000 }, async (t) => {
    const f = await fixture(t);
    const server = await f.start();
    const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'WriteContainment' })).QueueUrl;
    json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'last successful payload' }));
    assert.deepEqual(json(await admin(server, '/save', { method: 'POST', body: '{}' })), { saved: true });
    const path = join(f.stateDirectory, 'state.json');
    const backup = join(f.root, 'last-successful-state.json');
    const outside = join(f.root, 'outside-target.json');
    const good = await readFile(path);
    await writeFile(outside, good);
    await rename(path, backup);
    let sent;
    let unavailable = false;
    try {
      try {
        if (kind === 'hardlink') await link(outside, path);
        else await symlink(outside, path, 'file');
      } catch (error) {
        if (kind !== 'symlink' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
        unavailable = true;
        t.skip(`file symlinks unavailable: ${error.code}; no AWS evidence`);
      }
      if (!unavailable) {
        sent = json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'retry the dirty mutation' }));
        const failed = await admin(server, '/save', { method: 'POST', body: '{}' });
        assert.ok(failed.status >= 400 && failed.status < 600, 'unsafe destination must fail save');
        assert.notEqual(json(failed, failed.status)?.saved, true);
        assert.deepEqual(await readFile(outside), good);
        assert.deepEqual(await readFile(backup), good);
        assert.deepEqual(await readFile(path), good);
        if (kind === 'symlink') assert.ok((await lstat(path)).isSymbolicLink());
        else assert.equal((await stat(path)).ino, (await stat(outside)).ino);
      }
    } finally {
      await rm(path, { force: true });
      await rename(backup, path); // Restore before the shared fixture's bounded close.
    }
    if (unavailable) return;
    assert.deepEqual(json(await admin(server, '/save', { method: 'POST', body: '{}' })), { saved: true });
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    const messages = persisted.documents.find((d) => d.service === 'sqs').data.queues.find((q) => q.name === 'WriteContainment').messages;
    assert.ok(messages.some((m) => m.id === sent.MessageId && m.body === 'retry the dirty mutation'));
    assert.deepEqual(await readFile(outside), good);
  });
}
