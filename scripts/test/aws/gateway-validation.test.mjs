import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { URLSearchParams } from 'node:url';
import { evidence } from './contract-helpers.mjs';
import { awsFailure, DATE, deadline, fixture, json, jsonCall, presigned, queryCall, request, signing } from './http-helpers.mjs';

const jsonHeaders = () => ({ authorization: signing(), 'x-amz-date': DATE,
  'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AmazonSQS.CreateQueue' });
const queryHeaders = () => ({ authorization: signing(), 'x-amz-date': DATE, 'content-type': 'application/x-www-form-urlencoded' });

test(evidence(['sts.GetCallerIdentity'], 'protocol', 'missing malformed repeated or header-query ambiguous signing is an explanatory 403'), { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const form = 'Action=GetCallerIdentity&Version=2011-06-15';
  for (const authorization of [undefined, '', 'Bearer test', 'AWS4-HMAC-SHA256 Credential=test',
    signing('sts').replace('/aws4_request', '/wrong'), signing('sts').replace('/us-east-1/', '//'),
    signing('sts').replace('Signature=', 'MissingSignature=')]) {
    const response = await request(server.gatewayUrl, { method: 'POST', body: form,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-amz-date': DATE,
        ...(authorization === undefined ? {} : { authorization }) } });
    awsFailure(response, 'query', { statusCode: 403, message: /sign|auth|credential|scope/iu });
  }
  const duplicate = await request(server.gatewayUrl, { method: 'POST', body: form, headers: [
    'Authorization', signing('sts'), 'Authorization', signing('sts'),
    'Content-Type', 'application/x-www-form-urlencoded', 'X-Amz-Date', DATE,
  ] });
  awsFailure(duplicate, 'query', { statusCode: 403 });
  const parameters = new URLSearchParams({ Action: 'GetCallerIdentity', Version: '2011-06-15', ...presigned('sts') });
  awsFailure(await request(server.gatewayUrl, { path: `/?${parameters}`, headers: { authorization: signing('sts'), 'x-amz-date': DATE } }), 'query', { statusCode: 403 });
  awsFailure(await request(server.gatewayUrl, { path: `/?${parameters}&X-Amz-Credential=${encodeURIComponent('test/20261111/us-east-1/sts/aws4_request')}` }), 'query', { statusCode: 403 });
});

test(evidence(['sqs.CreateQueue', 'sqs.GetQueueUrl'], 'protocol', 'strict JSON rejects duplicate unknown prototype and malformed members before mutation'), { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const invalid = ['{', 'null', '[]', '"string"', '', '{}',
    '{"QueueName":"Rejected","QueueName":"Alias"}',
    '{"QueueName":"Rejected","Unknown":true}',
    '{"QueueName":"Rejected","__proto__":{"polluted":true}}',
    '{"QueueName":"Rejected","constructor":{}}', '{"QueueName":"Rejected","toString":"member"}',
    '{"QueueName":42}', '{"QueueName":null}', '{"QueueName":"Rejected","Attributes":[]}',
    '{"QueueName":"Rejected","Attributes":{"VisibilityTimeout":30}}',
  ];
  for (const body of invalid) {
    awsFailure(await request(server.gatewayUrl, { method: 'POST', headers: jsonHeaders(), body }), 'json');
  }
  for (const QueueName of ['Rejected', 'Alias']) {
    awsFailure(await jsonCall(server, 'GetQueueUrl', { QueueName }), 'json', { code: 'QueueDoesNotExist' });
  }
});

test(evidence(['sqs.CreateQueue', 'sqs.GetQueueUrl'], 'protocol', 'Query duplicate fields invalid form encodings and unknown bindings fail without creating queues'), { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const base = 'Action=CreateQueue&Version=2012-11-05&QueueName=Rejected';
  for (const body of [
    `${base}&Action=DeleteQueue`, `${base}&Version=2012-11-05`, `${base}&QueueName=Alias`,
    `${base}&Unknown=1`, `${base}&__proto__.polluted=yes`, `${base}&constructor=1`, `${base}&toString=1`,
    `${base}&Attribute.1.Name=VisibilityTimeout&Attribute.1.Value=0&Attribute.1.Value=30`,
    `${base}&Attribute.1.Name=VisibilityTimeout`, `${base}&Attribute.1.Wrong=0`,
    'Action=CreateQueue&Version=2012-11-05&QueueName=%ZZ',
    'Action=CreateQueue&Version=2012-11-05&QueueName=%C3%28',
    'Action=CreateQueue&Version=2012-11-05', 'Action=CreateQueue&QueueName=Rejected',
  ]) awsFailure(await request(server.gatewayUrl, { method: 'POST', body, headers: queryHeaders() }), 'query');
  for (const QueueName of ['Rejected', 'Alias']) {
    awsFailure(await jsonCall(server, 'GetQueueUrl', { QueueName }), 'json', { code: 'QueueDoesNotExist' });
  }
});

test(evidence(['sqs.SendMessage', 'sqs.ReceiveMessage'], 'protocol', 'typed numeric and feature-field validation preserves the pending message'), { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'typed-controls' })).QueueUrl;
  json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'survivor' }));
  for (const input of [{ MaxNumberOfMessages: '1' }, { MaxNumberOfMessages: 1.5 }, { MaxNumberOfMessages: 11 },
    { WaitTimeSeconds: {} }, { VisibilityTimeout: true }, { VisibilityTimeout: -1 },
    { MessageSystemAttributeNames: 'All' }, { MessageSystemAttributeNames: [7] },
    { MessageAttributeNames: ['All'] }, { ReceiveRequestAttemptId: 'unsupported' }]) {
    awsFailure(await jsonCall(server, 'ReceiveMessage', { QueueUrl, ...input }), 'json');
  }
  awsFailure(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: '\ud800' }), 'json', { code: 'InvalidMessageContents', statusCode: 400 });
  for (const input of [{ MessageBody: '' }, { DelaySeconds: '1' },
    { MessageGroupId: 'group' }, { MessageAttributes: { custom: { DataType: 'String', StringValue: 'value' } } }]) {
    awsFailure(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'rejected', ...input }), 'json');
  }
  for (const value of ['1.5', '1e0', 'true', 'NaN']) {
    awsFailure(await queryCall(server, 'sqs', 'ReceiveMessage', { QueueUrl, MaxNumberOfMessages: value }), 'query');
  }
  const received = json(await jsonCall(server, 'ReceiveMessage', { QueueUrl, MaxNumberOfMessages: 10 }));
  assert.deepEqual(received.Messages.map((message) => message.Body), ['survivor']);
});

test('gateway rejects unsupported methods versions targets services and encodings explicitly', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  for (const method of ['PUT', 'DELETE', 'GET']) {
    awsFailure(await request(server.gatewayUrl, { method, headers: jsonHeaders(), body: '{"QueueName":"Rejected"}' }), 'json');
  }
  for (const headers of [
    { authorization: signing('sts') }, { 'x-amz-target': 'OtherSQS.CreateQueue' },
    { 'x-amz-target': 'AmazonSQS.SyntheticUnknown' }, { 'x-amz-target': 'AmazonSQS' },
    { 'content-encoding': 'gzip' }, { 'content-type': 'application/x-amz-json-1.1' },
  ]) {
    const response = await request(server.gatewayUrl, { method: 'POST', headers: { ...jsonHeaders(), ...headers }, body: '{"QueueName":"Rejected"}' });
    assert.ok(response.status >= 400 && response.status < 500, response.text);
    requestIdPresent(response);
    assert.ok(response.text.length > 0);
  }
  awsFailure(await queryCall(server, 'sqs', 'CreateQueue', { QueueName: 'Rejected', Version: '2012-11-06' }), 'query');
  const unknownService = await queryCall(server, 'sts', 'GetCallerIdentity', {}, { headers: { authorization: signing('unmodeled') } });
  assert.ok(unknownService.status >= 400 && unknownService.status < 500);
  requestIdPresent(unknownService);
});

function requestIdPresent(response) {
  assert.equal(typeof response.headers['x-amzn-requestid'], 'string');
  assert.ok(response.headers['x-amzn-requestid'].length > 0);
}

test(evidence(['sqs.SendMessage', 'sqs.ReceiveMessage'], 'protocol', '2 MiB body cap returns 413 without echoing sensitive snippets or mutating a queue'), { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'body-cap' })).QueueUrl;
  const marker = 'SYNTHETIC_BODY_MUST_NOT_BE_ECHOED';
  const response = await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: marker + 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(response.status, 413, response.text);
  requestIdPresent(response);
  assert.ok(!response.text.includes(marker));
  assert.doesNotMatch(response.text, /node:internal|\n\s+at /u);
  assert.deepEqual(json(await jsonCall(server, 'ReceiveMessage', { QueueUrl })), {});
});

test(evidence(['sqs.CreateQueue', 'sqs.GetQueueUrl', 'sqs.SendMessage', 'sqs.ReceiveMessage'], 'protocol', 'signing regions isolate state while syntactically valid keys share default root'), { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'regional' })).QueueUrl;
  const other = json(await jsonCall(server, 'CreateQueue', { QueueName: 'regional' }, { region: 'ap-southeast-2' })).QueueUrl;
  assert.notEqual(other, QueueUrl);
  assert.equal(other, `${server.gatewayUrl}/000000000000/ap-southeast-2/regional`);
  assert.equal(json(await jsonCall(server, 'GetQueueUrl', { QueueName: 'regional' }, { headers: { authorization: signing('sqs', 'us-east-1', 'OTHER_SYNTHETIC_KEY') } })).QueueUrl, QueueUrl);
  awsFailure(await jsonCall(server, 'GetQueueUrl', { QueueName: 'regional', QueueOwnerAWSAccountId: '111122223333' }), 'json');
  awsFailure(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'wrong scope' }, { region: 'ap-southeast-2' }), 'json');
  assert.deepEqual(json(await jsonCall(server, 'ReceiveMessage', { QueueUrl })), {});
  assert.deepEqual(json(await jsonCall(server, 'ReceiveMessage', { QueueUrl: other }, { region: 'ap-southeast-2' })), {});
});

test(evidence(['sqs.SendMessage'], 'protocol', 'foreign QueueUrl is validated locally and never fetched'), { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  let connections = 0;
  const trap = createServer((req, res) => { res.end('must not be fetched'); });
  trap.on('connection', () => { connections += 1; });
  t.after(async () => {
    trap.closeAllConnections();
    await deadline(new Promise((resolve, reject) => trap.close((error) => error ? reject(error) : resolve())), 1000, 'outbound trap cleanup');
  });
  await new Promise((resolve) => trap.listen(0, '127.0.0.1', resolve));
  const QueueUrl = `http://127.0.0.1:${trap.address().port}/000000000000/us-east-1/foreign`;
  awsFailure(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'hello' }), 'json');
  assert.equal(connections, 0);
});
