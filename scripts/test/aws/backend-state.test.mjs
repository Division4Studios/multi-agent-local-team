import assert from 'node:assert/strict';
import { test } from 'node:test';
import { context, evidence, queue, rejectsAws, sqsHarness } from './contract-helpers.mjs';

const scope = { account: '000000000000', region: 'us-east-1' };
const copy = (value) => JSON.parse(JSON.stringify(value));

function scramble(value) {
  if (value === null || typeof value !== 'object') return;
  for (const [key, member] of Object.entries(value)) {
    if (member !== null && typeof member === 'object') scramble(member);
    else Reflect.set(value, key, 'mutated detached export');
  }
}

test(evidence(['sqs.GetQueueUrl', 'sqs.ReceiveMessage'], 'lifecycle', 'exported documents are detached even for nested data and scope objects'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h);
  await h.call('SendMessage', { QueueUrl, MessageBody: 'original detached body' });
  const exported = h.backend.exportState(scope);
  assert.equal(exported.formatVersion, 1);
  assert.equal(exported.service, 'sqs');
  assert.deepEqual(exported.scope, scope);
  const before = copy(exported);
  scramble(exported);
  assert.deepEqual(h.backend.exportState(scope), before);
  assert.equal((await h.call('GetQueueUrl', { QueueName: 'Synthetic_queue-1' })).QueueUrl, QueueUrl);
  assert.equal((await h.call('ReceiveMessage', { QueueUrl })).Messages[0].Body, 'original detached body');
});

test(evidence(['sqs.GetQueueUrl', 'sqs.ReceiveMessage', 'sqs.DeleteMessage'], 'lifecycle', 'export-import preserves current and superseded receipts and reconstructs a new endpoint'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h);
  await h.call('SendMessage', { QueueUrl, MessageBody: 'old receipt survivor' });
  const old = (await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 0 })).Messages[0];
  const current = (await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 10 })).Messages[0];
  await h.call('SendMessage', { QueueUrl, MessageBody: 'delete by persisted current receipt' });
  const toDelete = (await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 10 })).Messages[0];
  const restored = sqsHarness({ endpoint: 'http://127.0.0.1:49123' });
  restored.backend.importState(scope, copy(h.backend.exportState(scope)));
  const localUrl = (await restored.call('GetQueueUrl', { QueueName: 'Synthetic_queue-1' })).QueueUrl;
  assert.equal(localUrl, 'http://127.0.0.1:49123/000000000000/us-east-1/Synthetic_queue-1');
  await restored.call('DeleteMessage', { QueueUrl: localUrl, ReceiptHandle: old.ReceiptHandle });
  await restored.call('DeleteMessage', { QueueUrl: localUrl, ReceiptHandle: toDelete.ReceiptHandle });
  assert.deepEqual(await restored.call('ReceiveMessage', { QueueUrl: localUrl }), {});
  restored.advance(9999);
  assert.deepEqual(await restored.call('ReceiveMessage', { QueueUrl: localUrl }), {});
  restored.advance(1);
  const [survivor] = (await restored.call('ReceiveMessage', { QueueUrl: localUrl })).Messages;
  assert.equal(survivor.MessageId, current.MessageId);
  assert.equal(survivor.Body, 'old receipt survivor');
  assert.notEqual(survivor.ReceiptHandle, current.ReceiptHandle);
  await restored.call('DeleteMessage', { QueueUrl: localUrl, ReceiptHandle: survivor.ReceiptHandle });
  restored.advance(10000);
  assert.deepEqual(await restored.call('ReceiveMessage', { QueueUrl: localUrl }), {});
});

test(evidence(['sqs.ReceiveMessage'], 'lifecycle', 'import preserves delay visibility and retention absolute deadlines with an injected clock'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h, { Attributes: { MessageRetentionPeriod: '60', DelaySeconds: '2' } });
  await h.call('SendMessage', { QueueUrl, MessageBody: 'delayed' });
  await h.call('SendMessage', { QueueUrl, MessageBody: 'hidden', DelaySeconds: 0 });
  const hidden = (await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 3 })).Messages[0];
  h.advance(1000);
  const restored = sqsHarness();
  restored.advance(1000);
  restored.backend.importState(scope, copy(h.backend.exportState(scope)));
  restored.advance(999);
  assert.deepEqual(await restored.call('ReceiveMessage', { QueueUrl }), {});
  restored.advance(1);
  assert.equal((await restored.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 43200 })).Messages[0].Body, 'delayed');
  restored.advance(999);
  assert.deepEqual(await restored.call('ReceiveMessage', { QueueUrl }), {});
  restored.advance(1);
  assert.equal((await restored.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 0 })).Messages[0].MessageId, hidden.MessageId);
  restored.advance(56999);
  assert.equal((await restored.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 0 })).Messages[0].Body, 'hidden');
  restored.advance(1);
  assert.deepEqual(await restored.call('ReceiveMessage', { QueueUrl }), {});
});

test(evidence(['sqs.ReceiveMessage', 'sqs.DeleteMessage'], 'lifecycle', 'invalid version service scope or document fails import atomically without losing a current receipt'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h);
  await h.call('SendMessage', { QueueUrl, MessageBody: 'must survive invalid imports' });
  const current = (await h.call('ReceiveMessage', { QueueUrl })).Messages[0];
  const original = copy(h.backend.exportState(scope));
  const invalid = [null, false, [], {},
    { ...copy(original), formatVersion: 999 }, { ...copy(original), service: 'sts' },
    { ...copy(original), scope: { ...scope, account: '111122223333' } },
    { ...copy(original), scope: { ...scope, region: 'eu-west-1' } },
    { ...copy(original), data: null }, { ...copy(original), data: 'not service state' },
  ];
  for (const document of invalid) {
    assert.throws(() => h.backend.importState(scope, document));
    assert.deepEqual(h.backend.exportState(scope), original);
    assert.deepEqual(await h.call('ReceiveMessage', { QueueUrl }), {});
  }
  await h.call('DeleteMessage', { QueueUrl, ReceiptHandle: current.ReceiptHandle });
  h.advance(30000);
  assert.deepEqual(await h.call('ReceiveMessage', { QueueUrl }), {});
});

test(evidence(['sqs.GetQueueUrl', 'sqs.ReceiveMessage'], 'lifecycle', 'import replaces only its scope and reset supports one scope or all scopes'), async () => {
  const h = sqsHarness();
  const scopes = [context(), context({ region: 'eu-west-1' }), context({ account: '111122223333' })];
  const urls = [];
  for (const caller of scopes) {
    const QueueUrl = await queue(h, {}, caller);
    urls.push(QueueUrl);
    await h.call('SendMessage', { QueueUrl, MessageBody: `${caller.account}:${caller.region}` }, caller);
  }
  const saved = copy(h.backend.exportState(scope));
  await queue(h, { QueueName: 'CreatedAfterExport' });
  h.backend.importState(scope, saved);
  await rejectsAws(() => h.call('GetQueueUrl', { QueueName: 'CreatedAfterExport' }), { code: 'QueueDoesNotExist' });
  h.backend.reset(scope);
  await rejectsAws(() => h.call('GetQueueUrl', { QueueName: 'Synthetic_queue-1' }), { code: 'QueueDoesNotExist' });
  for (const [index, caller] of scopes.entries()) {
    if (index === 0) continue;
    assert.equal((await h.call('ReceiveMessage', { QueueUrl: urls[index] }, caller)).Messages[0].Body, `${caller.account}:${caller.region}`);
  }
  h.backend.reset('all');
  for (const caller of scopes) {
    await rejectsAws(() => h.call('GetQueueUrl', { QueueName: 'Synthetic_queue-1' }, caller), { code: 'QueueDoesNotExist' });
  }
});
