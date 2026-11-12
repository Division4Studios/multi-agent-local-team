import assert from 'node:assert/strict';
import { AwsAdminClient } from '../../cloud/adminClient';
import type { TestCase } from './harness';
import { httpFixture, replyJson } from './awsHttpFixture';
import { TEST_TOKEN, coverageValue, healthValue, queueValue, tracesValue } from './awsData';
import { assertSafeRejection } from './awsAdminOracleFixture';

const without = (value: object, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

const invalidHealth = (): readonly unknown[] => [
  null, [], {}, { ...healthValue(), status: 'healthy' }, { ...healthValue(), services: ['sqs'] },
  ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, null, '4'].map(requestCount => ({ ...healthValue(), requestCount })),
  ...Object.keys(healthValue()).map(key => without(healthValue(), key)),
  { ...healthValue(), token: TEST_TOKEN },
];

const invalidResources = (): readonly unknown[] => {
  const queue = queueValue();
  const { details } = queue;
  const queues: unknown[] = [
    ...Object.keys(queue).map(key => without(queue, key)),
    ...Object.keys(details).map(key => ({ ...queue, details: without(details, key) })),
    { ...queue, token: TEST_TOKEN }, { ...queue, details: { ...details, body: TEST_TOKEN } },
    { ...queue, details: { ...details, attributes: { ...details.attributes, secret: TEST_TOKEN } } },
    { ...queue, details: { ...details, messageCounts: { ...details.messageCounts, receipt: TEST_TOKEN } } },
    { ...queue, service: 'sts' }, { ...queue, type: 'topic' }, { ...queue, account: '123' },
    { ...queue, region: 'bad_region' }, { ...queue, id: 'arn:aws:sqs:us-east-1:000000000000:other' },
    { ...queue, details: { ...details, queueUrl: 'http://127.0.0.1:4566/000000000000/eu-west-1/orders' } },
  ];
  for (const key of Object.keys(details.attributes)) {
    queues.push({ ...queue, details: { ...details, attributes: without(details.attributes, key) } });
  }
  for (const key of Object.keys(details.messageCounts)) {
    queues.push({ ...queue, details: { ...details, messageCounts: without(details.messageCounts, key) } });
  }
  for (const key of ['available', 'delayed', 'inFlight']) {
    for (const value of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1, null, '2']) {
      queues.push({ ...queue, details: { ...details, messageCounts: { ...details.messageCounts, [key]: value } } });
    }
  }
  for (const attributes of [
    { ...details.attributes, VisibilityTimeout: '43201' }, { ...details.attributes, DelaySeconds: '-1' },
    { ...details.attributes, MessageRetentionPeriod: '59' }, { ...details.attributes, MaximumMessageSize: '0' },
    { ...details.attributes, ReceiveMessageWaitTimeSeconds: '21' },
  ]) {
    queues.push({ ...queue, details: { ...details, attributes } });
  }
  return [null, {}, { resources: [], secret: TEST_TOKEN }, ...queues.map(resource => ({ resources: [resource] }))];
};

const invalidCoverage = (): readonly unknown[] => {
  const service = coverageValue().services[0];
  assert.ok(service !== undefined);
  const operation = service.operations[0];
  assert.ok(operation !== undefined);
  const operations = [
    ...Object.keys(operation).map(key => without(operation, key)),
    { ...operation, status: 'passing' }, { ...operation, testKinds: ['imagined-pass'] },
    { ...operation, limitations: [42] }, { ...operation, secret: TEST_TOKEN },
    { ...operation, operation: 42 }, { ...operation, status: 42 },
    { ...operation, testKinds: 'unit' }, { ...operation, testKinds: [42] }, { ...operation, limitations: 'text' },
  ];
  return [
    {}, { services: [], secret: TEST_TOKEN }, { services: [{ ...service, secret: TEST_TOKEN }] },
    { services: [without(service, 'service')] }, { services: [without(service, 'operations')] },
    { services: [{ ...service, service: 42 }] }, { services: [{ ...service, operations: {} }] }, { services: {} },
    ...operations.map(value => ({ services: [{ ...service, operations: [value] }] })),
  ];
};

const invalidTraces = (): readonly unknown[] => {
  const trace = tracesValue().traces[0];
  assert.ok(trace !== undefined);
  const traces = [
    ...Object.keys(trace).map(key => without(trace, key)),
    { ...trace, durationMs: -1 }, { ...trace, durationMs: null }, { ...trace, durationMs: '0.5' }, { ...trace, statusCode: 200.5 },
    { ...trace, statusCode: '200' }, { ...trace, statusCode: -1 },
    ...['id', 'service', 'operation', 'account', 'region', 'principalArn', 'identity', 'decision'].map(key => ({ ...trace, [key]: 42 })),
    { ...trace, identity: 'authenticated-user' }, { ...trace, authorization: TEST_TOKEN },
    { ...trace, message: TEST_TOKEN }, { ...trace, receiptHandle: TEST_TOKEN },
  ];
  return [{}, { traces: [], secret: TEST_TOKEN }, ...traces.map(value => ({ traces: [value] }))];
};

const rejectsBodies = async (values: readonly unknown[], invoke: (client: AwsAdminClient) => Promise<unknown>): Promise<void> => {
  let body: unknown;
  const server = await httpFixture((...[, response]) => { replyJson(response, body); });
  const client = new AwsAdminClient({ url: server.origin, token: TEST_TOKEN });
  try {
    for (body of values) {
      await assertSafeRejection(server.track(invoke(client)));
    }
  } finally {
    await server.close();
  }
};

export const tests: readonly TestCase[] = [
  { name: 'AWS admin DTO: health requires the fixed fields and finite nonnegative safe counts',
    run: async (): Promise<void> => { await rejectsBodies(invalidHealth(), async client => await client.health()); } },
  { name: 'AWS admin DTO: resources validate identity, required nested fields and secret-bearing extras',
    run: async (): Promise<void> => { await rejectsBodies(invalidResources(), async client => await client.resources()); } },
  { name: 'AWS admin DTO: coverage requires declared statuses/test kinds and exact fields at every layer',
    run: async (): Promise<void> => { await rejectsBodies(invalidCoverage(), async client => await client.coverage()); } },
  { name: 'AWS admin DTO: traces reject invalid durations, identity and fields capable of carrying secrets',
    run: async (): Promise<void> => { await rejectsBodies(invalidTraces(), async client => await client.traces()); } },
  {
    name: 'AWS admin DTO: mutations require their exact affirmative acknowledgement',
    run: async (): Promise<void> => {
      await rejectsBodies([null, {}, { saved: false }, { saved: true, secret: TEST_TOKEN }, { reset: true }], async client => { await client.save(); });
      await rejectsBodies([{}, { reset: false }, { reset: true, secret: TEST_TOKEN }, { saved: true }], async client => { await client.reset('all'); });
      await rejectsBodies([{}, { stopping: false }, { stopping: true, secret: TEST_TOKEN }, { saved: true }], async client => { await client.shutdown(); });
    },
  },
];
