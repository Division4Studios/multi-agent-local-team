import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { evidence, models } from './contract-helpers.mjs';
import { fixture, json, jsonCall, queryCall, querySuccess, requestId, xmlText } from './http-helpers.mjs';
import { protocolSources, selectedCases } from './protocol-cases.mjs';

test('selected Smithy case provenance is pinned to original bytes, source trait, operation and literal appliesTo', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../../models/aws/sources.json', import.meta.url), 'utf8'));
  for (const selected of selectedCases) {
    const provenance = protocolSources[selected.source];
    assert.deepEqual(manifest.sources.find(({ file }) => file === provenance.file), provenance);
    const bytes = readFileSync(new URL(`../../../models/aws/${provenance.file}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.sha256);
    const text = bytes.toString('utf8');
    const marker = `apply ${selected.operation} @${selected.trait}([`;
    const start = text.indexOf(marker);
    assert.ok(start >= 0, marker);
    const block = text.slice(start, text.indexOf('\n])', start));
    const caseStart = block.indexOf(`id: "${selected.id}"`);
    assert.ok(caseStart >= 0, selected.id);
    const entry = block.slice(caseStart, block.indexOf('\n    }', caseStart));
    const appliesTo = /appliesTo: "([^"]+)"/u.exec(entry)?.[1] ?? null;
    assert.equal(appliesTo, selected.appliesTo);
    assert.notEqual(appliesTo, 'client');
  }
});

test(evidence(['sts.GetCallerIdentity'], 'protocol', 'Smithy QueryNoInputAndOutput request conversion uses only Action and Version'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const response = await queryCall(server, 'sts', 'GetCallerIdentity');
  querySuccess(response, 'sts', 'GetCallerIdentity');
  assert.equal(xmlText(response, 'Account'), '000000000000');
  assert.equal(xmlText(response, 'Arn'), 'arn:aws:iam::000000000000:root');
  assert.equal(xmlText(response, 'UserId'), '000000000000');
});

test(evidence(['sqs.DeleteQueue', 'sqs.DeleteMessage'], 'protocol', 'Smithy QueryNoInputAndNoOutputWithResponseMetadata conversion preserves matching request IDs'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'query-unit' })).QueueUrl;
  json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'hello' }));
  const [{ ReceiptHandle }] = json(await jsonCall(server, 'ReceiveMessage', { QueueUrl })).Messages;
  const deleted = await queryCall(server, 'sqs', 'DeleteMessage', { QueueUrl, ReceiptHandle });
  querySuccess(deleted, 'sqs', 'DeleteMessage');
  const removed = await queryCall(server, 'sqs', 'DeleteQueue', { QueueUrl });
  querySuccess(removed, 'sqs', 'DeleteQueue');
  assert.notEqual(requestId(deleted), requestId(removed));
});

test(evidence(['sqs.DeleteQueue', 'sqs.DeleteMessage'], 'protocol', 'Smithy AwsJson10ServiceRespondsWithNoPayload conversion requires zero bytes for Unit'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'json-unit' })).QueueUrl;
  json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'hello' }));
  const [{ ReceiptHandle }] = json(await jsonCall(server, 'ReceiveMessage', { QueueUrl })).Messages;
  for (const [operation, input] of [['DeleteMessage', { QueueUrl, ReceiptHandle }], ['DeleteQueue', { QueueUrl }]]) {
    assert.equal(models.sqs.shapes[`com.amazonaws.sqs#${operation}`].output.target, 'smithy.api#Unit');
    const response = await jsonCall(server, operation, input);
    assert.equal(response.status, 200, response.text);
    assert.match(response.headers['content-type'] ?? '', /^application\/x-amz-json-1\.0(?:;|$)/u);
    assert.equal(response.bytes, 0);
    requestId(response);
  }
});

test(evidence(['sqs.ReceiveMessage'], 'protocol', 'Smithy AwsJson10EmptyInputAndEmptyOutputSendJsonObject conversion serializes empty modeled result as an object'), { timeout: 12000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'empty-structure' })).QueueUrl;
  const response = await jsonCall(server, 'ReceiveMessage', { QueueUrl });
  assert.notEqual(models.sqs.shapes['com.amazonaws.sqs#ReceiveMessage'].output.target, 'smithy.api#Unit');
  assert.match(response.headers['content-type'] ?? '', /^application\/x-amz-json-1\.0(?:;|$)/u);
  assert.deepEqual(json(response), {});
  assert.ok(response.bytes >= 2);
  requestId(response);
});
