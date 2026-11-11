import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { evidence } from './contract-helpers.mjs';
import { awsFailure, deadline, fixture, json, jsonCall } from './http-helpers.mjs';

// Attach both handlers immediately: cleanup/close may reject an in-flight socket.
// The HTTP helper has an absolute deadline; the owning server is killable after
// a bounded public close() attempt even when implementation timers are defective.
function pendingReceive(server, QueueUrl, input = {}) {
  let settled = false;
  const outcome = jsonCall(server, 'ReceiveMessage', { QueueUrl, WaitTimeSeconds: 20, ...input }, { timeout: 3500 })
    .then((response) => ({ response }), (error) => ({ error }))
    .then((result) => { settled = true; return result; });
  return { outcome, settled: () => settled };
}

async function assertWaiting(pending) {
  await sleep(120);
  assert.equal(pending.settled(), false, 'long poll returned before any message was available');
}

test(evidence(['sqs.ReceiveMessage', 'sqs.SendMessage'], 'protocol', 'real long poll stays pending then wakes promptly for a newly sent message'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'poll-send' })).QueueUrl;
  const pending = pendingReceive(server, QueueUrl);
  await assertWaiting(pending);
  const sent = json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'wake up' }));
  const { response, error } = await deadline(pending.outcome, 1500, 'message arrival must wake long poll');
  assert.ifError(error);
  const [message] = json(response).Messages;
  assert.equal(message.MessageId, sent.MessageId);
  assert.equal(message.Body, 'wake up');
});

test(evidence(['sqs.ReceiveMessage'], 'protocol', 'empty long poll honors one-second request and queue-default wait deadlines'), { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'poll-timeout', Attributes: { ReceiveMessageWaitTimeSeconds: '1' } })).QueueUrl;
  for (const input of [{ WaitTimeSeconds: 1 }, {}]) {
    const start = Date.now();
    const response = await jsonCall(server, 'ReceiveMessage', { QueueUrl, ...input }, { timeout: 3000 });
    assert.deepEqual(json(response), {});
    assert.ok(Date.now() - start >= 800, 'one-second wait returned early');
    assert.ok(Date.now() - start < 3000, 'one-second wait exceeded the bounded deadline');
  }
  const immediate = await jsonCall(server, 'ReceiveMessage', { QueueUrl, WaitTimeSeconds: 0 }, { timeout: 700 });
  assert.deepEqual(json(immediate), {});
});

test(evidence(['sqs.ReceiveMessage'], 'protocol', 'real long poll wakes for visibility expiry and issues a fresh receipt'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'poll-visibility' })).QueueUrl;
  json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'visible again' }));
  const first = json(await jsonCall(server, 'ReceiveMessage', { QueueUrl, VisibilityTimeout: 1 })).Messages[0];
  const pending = pendingReceive(server, QueueUrl, { WaitTimeSeconds: 2 });
  await assertWaiting(pending);
  const { response, error } = await deadline(pending.outcome, 2500, 'visibility deadline must wake long poll');
  assert.ifError(error);
  const [second] = json(response).Messages;
  assert.equal(second.MessageId, first.MessageId);
  assert.notEqual(second.ReceiptHandle, first.ReceiptHandle);
});

test(evidence(['sqs.ReceiveMessage'], 'protocol', 'real long poll wakes when a delayed message becomes available'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'poll-delay' })).QueueUrl;
  const sent = json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'delayed arrival', DelaySeconds: 1 }));
  const pending = pendingReceive(server, QueueUrl, { WaitTimeSeconds: 2 });
  await assertWaiting(pending);
  const { response, error } = await deadline(pending.outcome, 2500, 'delay deadline must wake long poll');
  assert.ifError(error);
  assert.equal(json(response).Messages[0].MessageId, sent.MessageId);
});

test(evidence(['sqs.ReceiveMessage', 'sqs.DeleteQueue'], 'lifecycle', 'queue deletion wakes a pending twenty-second poll within a bounded interval'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'poll-delete' })).QueueUrl;
  const pending = pendingReceive(server, QueueUrl);
  await assertWaiting(pending);
  const deleted = await jsonCall(server, 'DeleteQueue', { QueueUrl });
  assert.equal(deleted.status, 200, deleted.text);
  const { response, error } = await deadline(pending.outcome, 1500, 'queue deletion must wake long poll');
  assert.ifError(error);
  // runtime.md specifies wakeup, not whether the in-flight receive is an empty
  // success or a missing-queue error. Both are explicit terminal outcomes.
  if (response.status === 200) assert.deepEqual(json(response), {});
  else awsFailure(response, 'json', { code: 'QueueDoesNotExist', statusCode: 400 });
});

test(evidence(['sqs.ReceiveMessage'], 'lifecycle', 'idempotent close wakes pending long polls and releases the live state owner'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'poll-close' })).QueueUrl;
  const pending = pendingReceive(server, QueueUrl);
  await assertWaiting(pending);
  await deadline(server.close(), 1800, 'close must wake pending polls rather than wait twenty seconds');
  const result = await deadline(pending.outcome, 1000, 'closed receive must settle');
  if (result.error) assert.ok(['ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(result.error.code), result.error.message);
  else if (result.response.status === 200) assert.deepEqual(json(result.response), {});
  else awsFailure(result.response, 'json');
  await server.close();
  const reopened = await f.start();
  assert.equal(json(await jsonCall(reopened, 'GetQueueUrl', { QueueName: 'poll-close' })).QueueUrl,
    `${reopened.gatewayUrl}/000000000000/us-east-1/poll-close`);
});
