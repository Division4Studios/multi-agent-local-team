import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { URL } from 'node:url';
import { evidence, IMPLEMENTED, models } from './contract-helpers.mjs';
import { admin, ADMIN_TOKEN, awsFailure, fixture, json, jsonCall, queryCall, querySuccess, request, requestId, signing } from './http-helpers.mjs';

test('every admin route including health and unknown paths requires the exact per-start bearer token', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  assert.equal(new URL(server.adminUrl).hostname, '127.0.0.1');
  assert.notEqual(new URL(server.adminUrl).port, new URL(server.gatewayUrl).port);
  for (const path of ['/health', '/resources', '/coverage', '/traces', '/save', '/reset', '/shutdown', '/unknown']) {
    for (const authorization of [undefined, `Bearer ${ADMIN_TOKEN}wrong`, `bearer ${ADMIN_TOKEN}`, `Bearer  ${ADMIN_TOKEN}`]) {
      const response = await request(`${server.adminUrl}${path}`, { headers: authorization === undefined ? {} : { authorization } });
      json(response, 401);
      assert.ok(!response.text.includes(ADMIN_TOKEN));
    }
  }
  json(await admin(server, '/unknown'), 404);
  const health = json(await admin(server, '/health'));
  assert.equal(health.status, 'running');
  assert.deepEqual(health.services, ['sqs', 'sts']);
  assert.equal(typeof health.requestCount, 'number');
  assert.ok(Number.isSafeInteger(health.requestCount) && health.requestCount >= 0);
  assert.notEqual((await request(`${server.gatewayUrl}/resources`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).status, 200);
});

test(evidence(['sqs.GetQueueUrl', 'sqs.ReceiveMessage'], 'lifecycle', 'invalid admin mutations have strict JSON boundaries and never reset state or stop the listener'), { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'admin-survivor' })).QueueUrl;
  json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'admin must not erase me' }));
  const invalid = [
    ['/reset', '{}'], ['/reset', '{"scope":"unknown"}'], ['/reset', '{"scope":{"account":"000000000000"}}'],
    ['/reset', '{"scope":"all","scope":{"account":"000000000000","region":"us-east-1"}}'],
    ['/reset', '{"scope":"all","extra":true}'], ['/reset', '{"scope":"all","__proto__":{}}'],
    ['/save', '{"extra":true}'], ['/shutdown', '{"extra":true}'],
  ];
  for (const [path, body] of invalid) json(await admin(server, path, { method: 'POST', body }), 400);
  for (const body of ['', '{', '[]', 'null', 'true']) json(await admin(server, '/reset', { method: 'POST', body }), 400);
  for (const path of ['/reset', '/save', '/shutdown']) {
    const response = await admin(server, path, { method: 'POST', body: path === '/reset' ? '{"scope":"all"}' : '{}', headers: { 'content-type': 'text/plain' } });
    assert.ok(response.status >= 400 && response.status < 500);
    json(response, response.status);
  }
  const oversized = await admin(server, '/reset', { method: 'POST', body: JSON.stringify({ scope: 'all', padding: 'x'.repeat(2 * 1024 * 1024) }) });
  assert.ok(oversized.status >= 400 && oversized.status < 500);
  json(oversized, oversized.status);
  assert.equal(json(await jsonCall(server, 'GetQueueUrl', { QueueName: 'admin-survivor' })).QueueUrl, QueueUrl);
  assert.equal(json(await jsonCall(server, 'ReceiveMessage', { QueueUrl })).Messages[0].Body, 'admin must not erase me');
  assert.equal(json(await admin(server, '/health')).status, 'running');
});

test('coverage includes every pinned operation with honest statuses limitations and no invented evidence', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const coverage = json(await admin(server, '/coverage'));
  assert.deepEqual(coverage.services.map(({ service }) => service).sort(), ['sqs', 'sts']);
  for (const entry of coverage.services) {
    assert.deepEqual(entry.operations.map(({ operation }) => operation).sort(), models[entry.service].operations);
    for (const operation of entry.operations) {
      assert.equal(operation.status, IMPLEMENTED[entry.service].includes(operation.operation) ? 'partial' : 'unsupported');
      assert.ok(Array.isArray(operation.limitations));
      if (IMPLEMENTED[entry.service].includes(operation.operation)) assert.ok(operation.limitations.length > 0);
      assert.ok(operation.limitations.every((item) => typeof item === 'string' && item.length > 0));
      assert.ok(Array.isArray(operation.testKinds));
      assert.ok(operation.testKinds.every((kind) => ['unit', 'protocol', 'lifecycle', 'workflow', 'differential'].includes(kind)));
      assert.equal(new Set(operation.testKinds).size, operation.testKinds.length);
      if (!existsSync(new URL('../../../out/aws/test-evidence.json', import.meta.url))) assert.deepEqual(operation.testKinds, []);
    }
  }
  const sts = coverage.services.find(({ service }) => service === 'sts');
  assert.match(sts.operations.find(({ operation }) => operation === 'GetCallerIdentity').limitations.join(' '), /root/iu);
  const sqs = coverage.services.find(({ service }) => service === 'sqs');
  assert.match(sqs.operations.find(({ operation }) => operation === 'CreateQueue').limitations.join(' '), /readiness|recreat|accelerat|creat.*delay|(?:one|sixty|60|1)[ -]second/iu);
  assert.match(sqs.operations.find(({ operation }) => operation === 'ReceiveMessage').limitations.join(' '), /determin|order|sampl|simulat/iu);
  assert.match(sqs.operations.find(({ operation }) => operation === 'DeleteMessage').limitations.join(' '), /duplicat|distribut/iu);
  assert.deepEqual(json(await admin(server, '/save', { method: 'POST', body: '{}' })), { saved: true });
  assert.deepEqual(JSON.parse(await readFile(join(f.stateDirectory, 'coverage.json'), 'utf8')), coverage);
});

test(evidence(['sts.GetCallerIdentity'], 'protocol', 'admin resources and root-permission traces redact credentials body text and receipts'), { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const key = 'SYNTHETIC_ACCESS_KEY_NEVER_LOG';
  const token = 'SYNTHETIC_SESSION_TOKEN_NEVER_LOG';
  const body = 'SYNTHETIC_MESSAGE_BODY_NEVER_LOG';
  const headers = { authorization: signing('sqs', 'us-east-1', key), 'x-amz-security-token': token };
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'metadata-only' }, { headers })).QueueUrl;
  json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: body }, { headers }));
  const [{ ReceiptHandle }] = json(await jsonCall(server, 'ReceiveMessage', { QueueUrl }, { headers })).Messages;
  const sts = await queryCall(server, 'sts', 'GetCallerIdentity', {}, { headers: { authorization: signing('sts', 'us-east-1', key), 'x-amz-security-token': token } });
  querySuccess(sts, 'sts', 'GetCallerIdentity');
  const resources = json(await admin(server, '/resources')).resources;
  assert.equal(resources.length, 1);
  const [resource] = resources;
  assert.equal(resource.service, 'sqs');
  assert.equal(resource.account, '000000000000');
  assert.equal(resource.region, 'us-east-1');
  assert.equal(resource.name, 'metadata-only');
  assert.equal(typeof resource.type, 'string');
  assert.equal(typeof resource.id, 'string');
  assert.ok(resource.details !== null && typeof resource.details === 'object');
  const traces = json(await admin(server, '/traces')).traces;
  assert.equal(traces[0].id, requestId(sts));
  assert.equal(traces[0].service, 'sts');
  assert.equal(traces[0].operation, 'GetCallerIdentity');
  assert.match(traces[0].decision, /exempt|permission/iu);
  assert.match(traces.find((trace) => trace.operation === 'SendMessage').decision, /root/iu);
  for (const trace of traces) {
    assert.equal(trace.account, '000000000000');
    assert.equal(trace.region, 'us-east-1');
    assert.equal(trace.principalArn, 'arn:aws:iam::000000000000:root');
    assert.equal(trace.identity, 'default-root');
    assert.equal(trace.statusCode, 200);
    assert.ok(Number.isFinite(trace.durationMs) && trace.durationMs >= 0);
  }
  const exposed = JSON.stringify({ resources, traces });
  for (const secret of [key, token, body, ReceiptHandle, ADMIN_TOKEN, headers.authorization]) assert.ok(!exposed.includes(secret), secret);
  assert.doesNotMatch(exposed, /"authorization"\s*:/iu);
});

test('trace ring is bounded at 200 and returns newest request first', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const ids = [];
  for (let index = 0; index < 205; index += 1) {
    const response = await queryCall(server, 'sts', 'GetCallerIdentity');
    assert.equal(response.status, 200, response.text);
    ids.push(requestId(response));
  }
  assert.deepEqual(json(await admin(server, '/traces')).traces.map(({ id }) => id), ids.slice(-200).reverse());
});

test(evidence(['sqs.GetQueueUrl'], 'lifecycle', 'admin reset is scoped saved and leaves neighboring regions intact'), { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  let server = await f.start();
  for (const region of ['us-east-1', 'eu-west-1']) json(await jsonCall(server, 'CreateQueue', { QueueName: 'reset-scope' }, { region }));
  assert.deepEqual(json(await admin(server, '/reset', { method: 'POST', body: '{"scope":{"account":"000000000000","region":"us-east-1"}}' })), { reset: true });
  await server.close();
  server = await f.start();
  awsFailure(await jsonCall(server, 'GetQueueUrl', { QueueName: 'reset-scope' }), 'json', { code: 'QueueDoesNotExist' });
  assert.equal(json(await jsonCall(server, 'GetQueueUrl', { QueueName: 'reset-scope' }, { region: 'eu-west-1' })).QueueUrl,
    `${server.gatewayUrl}/000000000000/eu-west-1/reset-scope`);
  assert.deepEqual(json(await admin(server, '/reset', { method: 'POST', body: '{"scope":"all"}' })), { reset: true });
  assert.deepEqual(json(await admin(server, '/resources')).resources, []);
  awsFailure(await jsonCall(server, 'GetQueueUrl', { QueueName: 'reset-scope' }, { region: 'eu-west-1' }), 'json', { code: 'QueueDoesNotExist' });
});
