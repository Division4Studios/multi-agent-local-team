import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { URL } from 'node:url';
import { ADMIN_TOKEN, admin, fixture, json, jsonCall, queryCall, querySuccess, signing } from './http-helpers.mjs';
import { effectiveAttributes, stateScope } from './state-integrity-fixtures.mjs';

// Independent oracles: runtime.md#queue-resources, state.md v1, and the SQS
// operation spec. These admin checks do not claim AWS operation evidence kinds.
const expectedResource = (origin, name, { scope = stateScope, attributes = {}, messageCounts = { available: 0, delayed: 0, inFlight: 0 } } = {}) => ({
  service: 'sqs', account: scope.account, region: scope.region, type: 'queue', name,
  id: `arn:aws:sqs:${scope.region}:${scope.account}:${name}`,
  details: {
    queueUrl: `${origin}/${scope.account}/${scope.region}/${name}`,
    attributes: { ...effectiveAttributes, ...attributes }, messageCounts,
  },
});

function assertResources(response, expected) {
  const value = json(response);
  assert.deepEqual(Object.keys(value), ['resources'], 'exact required envelope keys');
  assert.ok(Array.isArray(value.resources));
  const byId = (left, right) => left.id.localeCompare(right.id);
  // Full equality enforces required keys, types, and absence of extra nested
  // fields at every DTO layer without prescribing inventory ordering.
  assert.deepEqual([...value.resources].sort(byId), [...expected].sort(byId));
  return value.resources;
}

function assertRedacted(response, privateValues) {
  // Whole-response matching is only safe for authored, noncolliding sentinels.
  for (const value of privateValues) {
    assert.ok(value.length > 0, 'redaction controls must be nonempty');
    assert.equal(response.text.includes(value), false, 'admin resources exposed private data');
  }
}

const document = (scope, queues) => ({ formatVersion: 1, service: 'sqs', scope: { ...scope }, data: { queues } });
const storedQueue = (name, messages = [], attributes = {}) => ({ name, attributes: { ...effectiveAttributes, ...attributes }, messages });

async function seedState(f, documents) {
  await mkdir(f.stateDirectory, { recursive: true });
  await writeFile(join(f.stateDirectory, 'state.json'), JSON.stringify({ formatVersion: 1, documents }));
}

function storedMessage(label, sentAt, availableAt, receiveCount = 0) {
  return {
    id: `private-message-${label}`, body: `private-body-${label}`,
    sentAt, availableAt, expiresAt: sentAt + 120_000, receiveCount,
    oldReceipts: Array.from({ length: Math.max(0, receiveCount - 1) }, (_, index) => `private-old-receipt-${label}-${index}`),
    ...(receiveCount > 0 ? { firstReceivedAt: sentAt, currentReceipt: `private-current-receipt-${label}` } : {}),
  };
}

test('resource DTO oracle accepts short opaque identity collisions and rejects leaked fields', () => {
  const resource = expectedResource('http://127.0.0.1:45173', 'OracleQueue');
  const opaque = { MessageId: '1', ReceiptHandle: '0' };
  const sentinels = ['oracle-private-body-marker', 'OraclePrivateAccessKey123', ADMIN_TOKEN];
  const responseFor = (resources) => ({
    status: 200, headers: { 'content-type': 'application/json' }, text: JSON.stringify({ resources }),
  });
  const response = responseFor([resource]);
  for (const value of Object.values(opaque)) {
    assert.ok(response.text.includes(value), 'short opaque values also occur in legitimate metadata');
  }
  assertResources(response, [resource]);
  assertRedacted(response, sentinels);
  for (const [field, value] of Object.entries(opaque)) {
    const leaked = { ...resource, details: { ...resource.details, [field]: value } };
    assert.throws(() => assertResources(responseFor([leaked]), [resource]), { code: 'ERR_ASSERTION' });
  }
  const leakedSentinels = responseFor([{ ...resource, privateData: sentinels }]);
  assert.throws(() => assertResources(leakedSentinels, [resource]), { code: 'ERR_ASSERTION' });
  assert.throws(() => assertRedacted(leakedSentinels, sentinels), { code: 'ERR_ASSERTION' });
});

test('admin resource inventory is exactly empty before and after an STS identity call', async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  assertResources(await admin(server, '/resources'), []);
  querySuccess(await queryCall(server, 'sts', 'GetCallerIdentity'), 'sts', 'GetCallerIdentity');
  assertResources(await admin(server, '/resources'), []);
});

test('admin queue metadata has exact keys, effective decimal attributes, ARN identity and canonical URLs', async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const origin = new URL(server.gatewayUrl).origin;
  const settings = [
    ['ResourceDefaults', undefined],
    ['ResourcePartial', { VisibilityTimeout: '17' }],
    ['ResourceExplicit', {
      VisibilityTimeout: '43200', DelaySeconds: '900', MessageRetentionPeriod: '60',
      MaximumMessageSize: '1024', ReceiveMessageWaitTimeSeconds: '20',
    }],
  ];
  const expected = [];
  for (const [name, attributes] of settings) {
    const resource = expectedResource(origin, name, { attributes });
    const created = json(await jsonCall(server, 'CreateQueue', { QueueName: name, ...(attributes ? { Attributes: attributes } : {}) }));
    assert.equal(created.QueueUrl, resource.details.queueUrl);
    expected.push(resource);
  }
  assertResources(await admin(server, '/resources'), expected);
});

test('admin live counts are disjoint and expose no message bodies, receipts or credentials', async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const name = 'LiveResourceCounts';
  const accessKey = 'ResourceInventoryKey123456';
  const authorization = signing('sqs', stateScope.region, accessKey);
  const options = { headers: { authorization } };
  const resource = expectedResource(new URL(server.gatewayUrl).origin, name, { messageCounts: { available: 1, delayed: 1, inFlight: 1 } });
  const created = json(await jsonCall(server, 'CreateQueue', { QueueName: name }, options));
  const QueueUrl = created.QueueUrl;
  assert.equal(QueueUrl, resource.details.queueUrl);
  const bodies = ['private-live-inflight-body', 'private-live-delayed-body', 'private-live-available-body'];
  const sent = json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: bodies[0] }, options));
  assert.equal(typeof sent.MessageId, 'string');
  const received = json(await jsonCall(server, 'ReceiveMessage', { QueueUrl, VisibilityTimeout: 600, WaitTimeSeconds: 0 }, options));
  assert.equal(received.Messages.length, 1);
  const delivery = received.Messages[0];
  assert.equal(delivery.MessageId, sent.MessageId);
  assert.equal(delivery.Body, bodies[0]);
  assert.equal(typeof delivery.ReceiptHandle, 'string');
  const delayed = json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: bodies[1], DelaySeconds: 900 }, options));
  const available = json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: bodies[2], DelaySeconds: 0 }, options));
  assert.equal(typeof delayed.MessageId, 'string');
  assert.equal(typeof available.MessageId, 'string');
  const response = await admin(server, '/resources');
  assertResources(response, [resource]);
  assertRedacted(response, [...bodies, accessKey, authorization, ADMIN_TOKEN]);
});

test('admin counts exclude expired state in every bucket and classify visible-again deliveries as available', { timeout: 15_000 }, async (t) => {
  const f = await fixture(t);
  const now = Date.now();
  const freshSend = now - 5_000;
  const expiredSend = now - 180_000;
  const later = now + 600_000;
  const messages = [
    storedMessage('available', freshSend, freshSend),
    storedMessage('visible-again', freshSend, now - 2_000, 2),
    ...['a', 'b', 'c'].map((suffix, index) => storedMessage(`delayed-${suffix}`, freshSend, later + index * 1_000)),
    storedMessage('inflight', freshSend, later, 3),
    storedMessage('expired-available', expiredSend, expiredSend),
    storedMessage('expired-delayed', expiredSend, later),
    storedMessage('expired-inflight', expiredSend, later, 2),
  ];
  const attributes = { MessageRetentionPeriod: '120' };
  const name = 'PersistedResourceCounts';
  await seedState(f, [document(stateScope, [storedQueue(name, messages, attributes)])]);
  const server = await f.start();
  const response = await admin(server, '/resources');
  assertResources(response, [expectedResource(new URL(server.gatewayUrl).origin, name, {
    attributes, messageCounts: { available: 2, delayed: 3, inFlight: 1 },
  })]);
  const privateValues = messages.flatMap((message) => [message.id, message.body, ...message.oldReceipts,
    ...(message.currentReceipt ? [message.currentReceipt] : [])]);
  assertRedacted(response, [...privateValues, ADMIN_TOKEN]);
});

test('admin queue ARNs stay distinct by account, region and name case across restart with a new advertised port', async (t) => {
  const f = await fixture(t);
  const scopes = [stateScope, { ...stateScope, region: 'eu-west-1' }, { ...stateScope, account: '123456789012' }];
  const names = ['ScopedQueue', 'scopedQueue'];
  const documents = scopes.map((scope, index) => document(scope,
    (index === 0 ? names : names.slice(0, 1)).map((name) => storedQueue(name))));
  documents.push({ formatVersion: 1, service: 'sts', scope: { ...stateScope }, data: {} });
  await seedState(f, documents);
  const origins = ['http://127.0.0.1:45173', 'http://127.0.0.1:45174'];
  const expected = (origin) => scopes.flatMap((scope, index) =>
    (index === 0 ? names : names.slice(0, 1)).map((name) => expectedResource(origin, name, { scope })));
  const first = await f.start({ endpoint: origins[0] });
  const before = assertResources(await admin(first, '/resources'), expected(origins[0]));
  assert.equal(new Set(before.map(({ id }) => id)).size, 4);
  await first.close();
  const reopened = await f.start({ endpoint: origins[1] });
  const after = assertResources(await admin(reopened, '/resources'), expected(origins[1]));
  assert.deepEqual(after.map(({ id }) => id).sort(), before.map(({ id }) => id).sort());
  assert.ok(after.every(({ details }) => new URL(details.queueUrl).port === '45174'));
});
