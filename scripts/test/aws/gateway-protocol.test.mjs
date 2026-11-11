import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL } from 'node:url';
import { ESCAPED_BODY, ESCAPED_MD5, evidence, HELLO_MD5, queryError } from './contract-helpers.mjs';
import { admin, awsFailure, fixture, json, jsonCall, queryCall, querySuccess, request, requestId, xmlText } from './http-helpers.mjs';

test(evidence(['sts.GetCallerIdentity'], 'protocol', 'signed form POST and presigned GET agree on root identity with distinct request IDs'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const responses = [await queryCall(server, 'sts', 'GetCallerIdentity'),
    await queryCall(server, 'sts', 'GetCallerIdentity', {}, { method: 'GET', presigned: true })];
  for (const response of responses) {
    querySuccess(response, 'sts', 'GetCallerIdentity');
    assert.equal(xmlText(response, 'Account'), '000000000000');
    assert.equal(xmlText(response, 'Arn'), 'arn:aws:iam::000000000000:root');
    assert.equal(xmlText(response, 'UserId'), '000000000000');
  }
  assert.notEqual(requestId(responses[0]), requestId(responses[1]));
});

test('public health lists both services and is excluded from the AWS request count', { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const before = json(await admin(server, '/health'));
  for (let index = 0; index < 3; index += 1) {
    const health = json(await request(`${server.gatewayUrl}/_health`));
    assert.equal(health.status, 'running');
    assert.deepEqual((Array.isArray(health.services) ? [...health.services] : Object.keys(health.services)).sort(), ['sqs', 'sts']);
  }
  assert.equal(json(await admin(server, '/health')).requestCount, before.requestCount);
  querySuccess(await queryCall(server, 'sts', 'GetCallerIdentity'), 'sts', 'GetCallerIdentity');
  assert.equal(json(await admin(server, '/health')).requestCount, before.requestCount + 1);
});

test(evidence(['sts.GetCallerIdentity'], 'protocol', 'body-supplied identity fields are rejected rather than trusted'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  for (const input of [{ Account: '111122223333' }, { Arn: 'arn:aws:iam::111122223333:root' }, { UserId: 'forged' }]) {
    awsFailure(await queryCall(server, 'sts', 'GetCallerIdentity', input), 'query');
  }
  const response = await queryCall(server, 'sts', 'GetCallerIdentity');
  querySuccess(response, 'sts', 'GetCallerIdentity');
  assert.equal(xmlText(response, 'Account'), '000000000000');
  assert.equal(xmlText(response, 'Arn'), 'arn:aws:iam::000000000000:root');
  assert.equal(xmlText(response, 'UserId'), '000000000000');
});

test(evidence(['sqs.CreateQueue', 'sqs.GetQueueUrl', 'sqs.SendMessage', 'sqs.ReceiveMessage', 'sqs.DeleteMessage'], 'protocol', 'JSON send to Query receive and Query send to JSON receive share exact escaped UTF-8 state'), { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'Wire_queue-1' })).QueueUrl;
  assert.equal(QueueUrl, `${server.gatewayUrl}/000000000000/us-east-1/Wire_queue-1`);
  const lookup = await queryCall(server, 'sqs', 'GetQueueUrl', { QueueName: 'Wire_queue-1' }, { method: 'GET', presigned: true });
  querySuccess(lookup, 'sqs', 'GetQueueUrl');
  assert.equal(xmlText(lookup, 'QueueUrl'), QueueUrl);
  const sent = json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: ESCAPED_BODY }));
  assert.equal(sent.MD5OfMessageBody, ESCAPED_MD5);
  const received = await queryCall(server, 'sqs', 'ReceiveMessage', { QueueUrl, 'AttributeName.1': 'All' });
  querySuccess(received, 'sqs', 'ReceiveMessage');
  assert.equal(xmlText(received, 'Body'), ESCAPED_BODY);
  assert.equal(xmlText(received, 'MD5OfBody'), ESCAPED_MD5);
  assert.equal(xmlText(received, 'MessageId'), sent.MessageId);
  assert.ok(!received.text.includes('queue <&>'));
  assert.match(received.text, /<Attribute>\s*<Name>/u);
  assert.ok(received.text.includes('ApproximateReceiveCount'));
  const removed = await jsonCall(server, 'DeleteMessage', { QueueUrl, ReceiptHandle: xmlText(received, 'ReceiptHandle') });
  assert.equal(removed.status, 200);
  assert.equal(removed.bytes, 0);
  const secondSend = await queryCall(server, 'sqs', 'SendMessage', { QueueUrl, MessageBody: 'hello' });
  querySuccess(secondSend, 'sqs', 'SendMessage');
  assert.equal(xmlText(secondSend, 'MD5OfMessageBody'), HELLO_MD5);
  const [second] = json(await jsonCall(server, 'ReceiveMessage', { QueueUrl })).Messages;
  assert.equal(second.Body, 'hello');
  assert.equal(second.MD5OfBody, HELLO_MD5);
  assert.equal(second.MessageId, xmlText(secondSend, 'MessageId'));
});

test(evidence(['sqs.CreateQueue', 'sqs.ReceiveMessage'], 'protocol', 'flattened Query Attribute.Name/Value map actually configures visibility'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const created = await queryCall(server, 'sqs', 'CreateQueue', {
    QueueName: 'flattened', 'Attribute.1.Name': 'VisibilityTimeout', 'Attribute.1.Value': '0',
    'Attribute.2.Name': 'MaximumMessageSize', 'Attribute.2.Value': '1024',
  });
  querySuccess(created, 'sqs', 'CreateQueue');
  const QueueUrl = xmlText(created, 'QueueUrl');
  json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'hello' }));
  const first = json(await jsonCall(server, 'ReceiveMessage', { QueueUrl })).Messages[0];
  const second = json(await jsonCall(server, 'ReceiveMessage', { QueueUrl, MessageSystemAttributeNames: ['ApproximateReceiveCount'] })).Messages[0];
  assert.equal(second.MessageId, first.MessageId);
  assert.notEqual(second.ReceiptHandle, first.ReceiptHandle);
  assert.deepEqual(second.Attributes, { ApproximateReceiveCount: '2' });
});

test(evidence(['sqs.SendMessage', 'sqs.ReceiveMessage'], 'protocol', 'legacy Query can recover the queue from the path and conflicting identities fail atomically'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'path-queue' })).QueueUrl;
  const secondUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'other-queue' })).QueueUrl;
  const path = new URL(QueueUrl).pathname;
  const sent = await queryCall(server, 'sqs', 'SendMessage', { MessageBody: 'hello' }, { path });
  querySuccess(sent, 'sqs', 'SendMessage');
  assert.equal(xmlText(sent, 'MD5OfMessageBody'), HELLO_MD5);
  awsFailure(await queryCall(server, 'sqs', 'SendMessage', { QueueUrl: secondUrl, MessageBody: 'conflicting' }, { path }), 'query');
  assert.deepEqual(json(await jsonCall(server, 'ReceiveMessage', { QueueUrl: secondUrl })), {});
  assert.equal(json(await jsonCall(server, 'ReceiveMessage', { QueueUrl })).Messages[0].Body, 'hello');
  awsFailure(await jsonCall(server, 'SendMessage', { MessageBody: 'JSON cannot recover the path' }, { path }), 'json');
});

test(evidence(['sqs.GetQueueUrl', 'sqs.CreateQueue', 'sqs.DeleteMessage'], 'protocol', 'modeled Query error traits differ from JSON shape names and status codes are retained'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  awsFailure(await queryCall(server, 'sqs', 'GetQueueUrl', { QueueName: 'absent' }), 'query', queryError('sqs', 'QueueDoesNotExist'));
  awsFailure(await jsonCall(server, 'GetQueueUrl', { QueueName: 'absent' }), 'json', { code: 'QueueDoesNotExist', statusCode: 400 });
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'exists' })).QueueUrl;
  awsFailure(await queryCall(server, 'sqs', 'CreateQueue', {
    QueueName: 'exists', 'Attribute.1.Name': 'VisibilityTimeout', 'Attribute.1.Value': '31',
  }), 'query', queryError('sqs', 'QueueNameExists'));
  awsFailure(await jsonCall(server, 'CreateQueue', { QueueName: 'exists', Attributes: { VisibilityTimeout: '31' } }), 'json', { code: 'QueueNameExists', statusCode: 400 });
  awsFailure(await queryCall(server, 'sqs', 'DeleteMessage', { QueueUrl, ReceiptHandle: 'unknown' }), 'query', queryError('sqs', 'ReceiptHandleIsInvalid'));
  awsFailure(await jsonCall(server, 'DeleteMessage', { QueueUrl, ReceiptHandle: 'unknown' }), 'json', { code: 'ReceiptHandleIsInvalid', statusCode: 404 });
});
