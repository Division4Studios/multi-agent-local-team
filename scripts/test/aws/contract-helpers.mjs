import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { URL } from 'node:url';

const require = createRequire(import.meta.url);
export const ROOT_ACCOUNT = '000000000000';
export const ENDPOINT = 'http://127.0.0.1:4566';
export const IMPLEMENTED = Object.freeze({
  sts: ['GetCallerIdentity'],
  sqs: ['CreateQueue', 'GetQueueUrl', 'DeleteQueue', 'SendMessage', 'ReceiveMessage', 'DeleteMessage'],
});
export const HELLO_MD5 = '5d41402abc4b2a76b9719d911017c592';
export const ESCAPED_BODY = 'queue <&> "quoted" \'single\' + % / \u{1f600}\n\tcaf\u00e9';
export const ESCAPED_MD5 = 'f9296191400d54ff75e895fd88b089c3';

// Original synthetic inputs. Inventory and traits come directly from pinned models,
// never a generated descriptor or an implementation declaration.
export const models = Object.fromEntries(['sts', 'sqs'].map((name) => {
  const model = JSON.parse(readFileSync(new URL(`../../../models/aws/${name}.json`, import.meta.url), 'utf8'));
  const service = Object.values(model.shapes).find((shape) => shape.type === 'service');
  return [name, { ...model, service, operations: service.operations.map(({ target }) => target.split('#')[1]).sort() }];
}));

export function evidence(operations, kind, description) {
  return `aws[${operations.join(',')};${kind}] ${description}`;
}

export function context(overrides = {}) {
  const account = overrides.account ?? ROOT_ACCOUNT;
  return {
    account, region: 'us-east-1', accessKeyId: 'test',
    principalArn: `arn:aws:iam::${account}:root`, traceId: 'synthetic-backend-trace',
    emit: () => {}, ...overrides,
  };
}

export function sqsHarness(options = {}) {
  const { createSqsBackend } = require('../../../out/aws/services/sqs/backend.js');
  let time = 1_800_000_000_000;
  const backend = createSqsBackend({ endpoint: ENDPOINT, now: () => time, ...options });
  return {
    backend,
    now: () => time,
    advance: (milliseconds) => { time += milliseconds; },
    call: (operation, input = {}, caller = context()) => backend.handle({ operation, input }, caller),
  };
}

export function stsBackend() {
  return require('../../../out/aws/services/sts/backend.js').createStsBackend();
}

export async function rejectsAws(action, expected = {}) {
  const { AwsError } = require('../../../out/aws/protocol/errors.js');
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof AwsError, `expected AwsError, received ${error}`);
    assert.ok(error.code.length > 0);
    assert.ok(error.message.length > 0);
    assert.ok(error.statusCode >= 400 && error.statusCode < 600);
    assert.equal(error.fault, 'Sender');
    for (const [key, value] of Object.entries(expected)) {
      if (value instanceof RegExp) assert.match(error[key], value);
      else assert.equal(error[key], value, key);
    }
    return true;
  });
}

export async function queue(harness, input = {}, caller = context()) {
  const result = await harness.call('CreateQueue', { QueueName: 'Synthetic_queue-1', ...input }, caller);
  assert.equal(typeof result.QueueUrl, 'string');
  return result.QueueUrl;
}

export function messages(result) {
  return result.Messages ?? [];
}

export function queryError(service, code) {
  const shape = models[service].shapes[`com.amazonaws.${service}#${code}`];
  const trait = shape?.traits?.['aws.protocols#awsQueryError'];
  return { code: trait?.code ?? code, statusCode: trait?.httpResponseCode ?? shape?.traits?.['smithy.api#httpError'] ?? 400 };
}

// No SQS xmlNamespace trait is present in the pinned JSON-protocol model.
// This legacy namespace is the documented CreateQueue Query response example:
// https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_CreateQueue.html
export const namespaces = {
  sts: models.sts.service.traits['smithy.api#xmlNamespace'].uri,
  sqs: 'http://queue.amazonaws.com/doc/2012-11-05/',
};
