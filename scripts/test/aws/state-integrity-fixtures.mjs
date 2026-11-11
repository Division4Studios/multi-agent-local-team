import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { context, queue, sqsHarness } from './contract-helpers.mjs';

// Original synthetic documents for the public format in specs/aws/state.md.
export const stateScope = Object.freeze({ account: '000000000000', region: 'us-east-1' });
export const effectiveAttributes = Object.freeze({ VisibilityTimeout: '30', DelaySeconds: '0',
  MessageRetentionPeriod: '345600', MaximumMessageSize: '1048576', ReceiveMessageWaitTimeSeconds: '0' });
export const cloneDocument = (value) => JSON.parse(JSON.stringify(value));

export function portableDocument() {
  return { formatVersion: 1, service: 'sqs', scope: { ...stateScope }, data: { queues: [
    { name: 'Portable', attributes: { ...effectiveAttributes }, messages: [
      { id: 'portable-message', body: 'portable body', sentAt: 1800000000000, availableAt: 1800000000000,
        expiresAt: 1800345600000, receiveCount: 0, oldReceipts: [] },
    ] },
  ] } };
}

export async function liveStateFixture() {
  const h = sqsHarness();
  const QueueUrl = await queue(h, { QueueName: 'Integrity' });
  const sent = await h.call('SendMessage', { QueueUrl, MessageBody: 'original delivered body' });
  await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 0 });
  const current = (await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 30 })).Messages[0];
  assert.equal(current.MessageId, sent.MessageId);
  await h.call('SendMessage', { QueueUrl, MessageBody: 'original available body' });
  await queue(h, { QueueName: 'LaterQueue' });
  const neighbor = context({ region: 'eu-west-1' });
  await queue(h, { QueueName: 'Neighbor' }, neighbor);
  const original = cloneDocument(h.backend.exportState(stateScope));
  assert.deepEqual(primaryQueue(original).attributes, effectiveAttributes);
  return { h, QueueUrl, current, original, neighbor,
    otherState: cloneDocument(h.backend.exportState(neighbor)) };
}

export const primaryQueue = (document) => document.data.queues.find(({ name }) => name === 'Integrity');
export const delivered = (document) => primaryQueue(document).messages.find(({ receiveCount }) => receiveCount > 0);
export const untouched = (document) => primaryQueue(document).messages.find(({ receiveCount }) => receiveCount === 0);

function retimeDelivery(document, sentAt) {
  const message = delivered(document);
  message.sentAt = sentAt;
  message.expiresAt = sentAt + Number(primaryQueue(document).attributes.MessageRetentionPeriod) * 1000;
  return message;
}

export const invalidStateCases = [
  ['missing queues', (d) => { delete d.data.queues; }],
  ['non-array queues', (d) => { d.data.queues = {}; }],
  ['null queue', (d) => { d.data.queues.push(null); }],
  ['non-array messages', (d) => { primaryQueue(d).messages = {}; }],
  ['null message', (d) => { primaryQueue(d).messages.push(null); }],
  ['non-object attributes', (d) => { primaryQueue(d).attributes = []; }],
  ['missing message body', (d) => { delete delivered(d).body; }],
  ['non-string message identity', (d) => { delivered(d).id = 42; }],
  ['missing old receipts', (d) => { delete delivered(d).oldReceipts; }],
  ['missing send time', (d) => { delete delivered(d).sentAt; }],
  ['invalid queue name', (d) => { primaryQueue(d).name = '../escape'; }],
  ['duplicate queue name', (d) => { d.data.queues.push(cloneDocument(primaryQueue(d))); }],
  ['missing effective attribute', (d) => { delete primaryQueue(d).attributes.DelaySeconds; }],
  ['unknown attribute', (d) => { primaryQueue(d).attributes.Policy = '{}'; }],
  ['non-string attribute', (d) => { primaryQueue(d).attributes.VisibilityTimeout = 30; }],
  ['out-of-range attribute', (d) => { primaryQueue(d).attributes.MaximumMessageSize = '1023'; }],
  ['empty body', (d) => { delivered(d).body = ''; }],
  ['unpaired surrogate body', (d) => { delivered(d).body = '\ud800'; }],
  ['body exceeds queue byte limit', (d) => { primaryQueue(d).attributes.MaximumMessageSize = '1024'; delivered(d).body = '\u00e9'.repeat(513); }],
  ['empty message identity', (d) => { delivered(d).id = ''; }],
  ['oversized message identity', (d) => { delivered(d).id = 'm'.repeat(2049); }],
  ['control character identity', (d) => { delivered(d).id = 'm\u007f'; }],
  ['duplicate message identity', (d) => { untouched(d).id = delivered(d).id; }],
  ['empty receipt', (d) => { delivered(d).currentReceipt = ''; }],
  ['oversized receipt', (d) => { delivered(d).currentReceipt = 'r'.repeat(2049); }],
  ['control character old receipt', (d) => { delivered(d).oldReceipts[0] = 'r\n'; }],
  ['non-array old receipts', (d) => { delivered(d).oldReceipts = {}; }],
  ['non-string old receipt', (d) => { delivered(d).oldReceipts[0] = 7; }],
  ['current receipt also old', (d) => { delivered(d).oldReceipts[0] = delivered(d).currentReceipt; }],
  ['duplicate old receipt', (d) => { const m = delivered(d); m.oldReceipts.push(m.oldReceipts[0]); m.receiveCount = 3; }],
  ['receipt shared across messages', (d) => { const m = untouched(d); m.receiveCount = 1; m.firstReceivedAt = m.sentAt; m.currentReceipt = delivered(d).oldReceipts[0]; }],
  ['incorrect old-receipt count', (d) => { delivered(d).receiveCount = 3; }],
  ['missing positive-count first receive', (d) => { delete delivered(d).firstReceivedAt; }],
  ['missing positive-count current receipt', (d) => { delete delivered(d).currentReceipt; }],
  ['zero-count first receive', (d) => { untouched(d).firstReceivedAt = untouched(d).sentAt; }],
  ['zero-count current receipt', (d) => { untouched(d).currentReceipt = 'unissued'; }],
  ['zero-count old receipt', (d) => { untouched(d).oldReceipts = ['unissued']; }],
  ['availability before send', (d) => { delivered(d).availableAt = delivered(d).sentAt - 1; }],
  ['expiry not after send', (d) => { delivered(d).expiresAt = delivered(d).sentAt; }],
  ['retention deadline mismatch', (d) => { delivered(d).expiresAt += 1; }],
  ['first receive before send', (d) => { delivered(d).firstReceivedAt = delivered(d).sentAt - 1; }],
  ['unknown envelope claims', (d) => { d.testKinds = ['verified']; }],
  ['unknown scope field', (d) => { d.scope.endpoint = 'http://outside.invalid'; }],
  ['stored data path', (d) => { d.data.path = '../../outside'; }],
  ['stored queue endpoint', (d) => { primaryQueue(d).endpoint = 'http://outside.invalid'; }],
  ['stored message path', (d) => { delivered(d).blobPath = '../../outside'; }],
  ['late invalid queue after a valid replacement', (d) => { d.data.queues.find(({ name }) => name === 'LaterQueue').messages = null; }],
];

for (const field of ['sentAt', 'availableAt', 'expiresAt', 'firstReceivedAt']) {
  for (const [name, value] of [['NaN', NaN], ['infinite', Infinity]]) {
    invalidStateCases.push([`${name} ${field}`, (d) => { delivered(d)[field] = value; }]);
  }
}
// Isolate integer/nonnegative checks from the separately tested time relationships.
// Send and expiry move together because retention is an integer-millisecond span.
invalidStateCases.push(
  ['fractional sentAt', (d) => { retimeDelivery(d, delivered(d).sentAt - 0.5); }],
  ['fractional availableAt', (d) => { delivered(d).availableAt += 0.5; }],
  ['fractional expiresAt', (d) => { retimeDelivery(d, delivered(d).sentAt - 1.5); }],
  ['fractional firstReceivedAt', (d) => { delivered(d).firstReceivedAt += 0.5; }],
  ['negative sentAt', (d) => { retimeDelivery(d, -1); }],
  ['negative availableAt', (d) => { retimeDelivery(d, -1).availableAt = -1; }],
  ['negative expiresAt', (d) => { retimeDelivery(d, -Number(primaryQueue(d).attributes.MessageRetentionPeriod) * 1000 - 1); }],
  ['negative firstReceivedAt', (d) => { retimeDelivery(d, -1).firstReceivedAt = -1; }],
);
for (const [name, value] of [['negative', -1], ['fractional', 1.5], ['NaN', NaN], ['infinite', Infinity],
  ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['string', '2']]) {
  invalidStateCases.push([`${name} receive count`, (d) => { delivered(d).receiveCount = value; }]);
}

export async function durableState(path, predicate, allowance = 4000) {
  const end = Date.now() + allowance;
  do {
    let text;
    try { text = await readFile(path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (text !== undefined) {
      const state = JSON.parse(text); // A partial/corrupt write is a failure, not a retry.
      if (predicate(state)) return state;
    }
    await sleep(25);
  } while (Date.now() < end);
  assert.fail(`dirty state was not durable within ${allowance}ms: ${path}`);
}
