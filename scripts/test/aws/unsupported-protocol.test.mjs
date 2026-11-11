import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidence, IMPLEMENTED, models } from './contract-helpers.mjs';
import { awsFailure, fixture, json, jsonCall, queryCall } from './http-helpers.mjs';
import { unsupportedInputs, unsupportedSqsQuery } from './unsupported-inputs.mjs';

test('unsupported wire fixtures exactly cover the complements of the pinned service inventories', () => {
  for (const service of ['sts', 'sqs']) {
    const expected = models[service].operations.filter((operation) => !IMPLEMENTED[service].includes(operation));
    assert.deepEqual(Object.keys(unsupportedInputs('http://127.0.0.1:1/unused')[service]).sort(), expected);
    if (service === 'sqs') assert.deepEqual(Object.keys(unsupportedSqsQuery('http://127.0.0.1:1/unused')).sort(), expected);
  }
  assert.equal(models.sqs.operations.length, 23);
  assert.equal(models.sts.operations.length, 11);
});

for (const service of ['sts', 'sqs']) {
  for (const operation of models[service].operations.filter((name) => !IMPLEMENTED[service].includes(name))) {
    test(evidence([`${service}.${operation}`], 'protocol', 'each supported wire protocol returns named UnsupportedOperation for the pinned operation'), { timeout: 12000 }, async (t) => {
      const f = await fixture(t);
      const server = await f.start();
      const QueueUrl = service === 'sqs' ? json(await jsonCall(server, 'CreateQueue', { QueueName: 'unsupported-fixture' })).QueueUrl : undefined;
      const expected = { code: 'UnsupportedOperation', statusCode: 400, message: new RegExp(`(?=.*${service})(?=.*${operation})`, 'isu') };
      if (service === 'sqs') {
        awsFailure(await jsonCall(server, operation, unsupportedInputs(QueueUrl).sqs[operation]), 'json', expected);
        awsFailure(await queryCall(server, 'sqs', operation, unsupportedSqsQuery(QueueUrl)[operation]), 'query', expected);
      } else {
        awsFailure(await queryCall(server, 'sts', operation, unsupportedInputs(QueueUrl).sts[operation]), 'query', expected);
      }
    });
  }
}

test(evidence(['sqs.PurgeQueue', 'sqs.SetQueueAttributes', 'sqs.ReceiveMessage'], 'protocol', 'unsupported mutators cannot clear messages or change their visibility'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'unsupported-no-mutation' })).QueueUrl;
  json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'must survive' }));
  awsFailure(await jsonCall(server, 'PurgeQueue', { QueueUrl }), 'json', { code: 'UnsupportedOperation', statusCode: 400 });
  awsFailure(await jsonCall(server, 'SetQueueAttributes', { QueueUrl, Attributes: { VisibilityTimeout: '0' } }), 'json', { code: 'UnsupportedOperation', statusCode: 400 });
  assert.equal(json(await jsonCall(server, 'ReceiveMessage', { QueueUrl })).Messages[0].Body, 'must survive');
  assert.deepEqual(json(await jsonCall(server, 'ReceiveMessage', { QueueUrl })), {});
});
