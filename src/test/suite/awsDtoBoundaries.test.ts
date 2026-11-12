import assert from 'node:assert/strict';
import { AwsAdminClient } from '../../cloud/adminClient';
import type { TestCase } from './harness';
import { httpFixture, replyJson } from './awsHttpFixture';
import { assertSafeRejection } from './awsAdminOracleFixture';
import { TEST_TOKEN, healthValue, queueValue, tracesValue } from './awsData';

const checkBodies = async (bodies: readonly unknown[], method: 'health' | 'resources' | 'traces', valid: boolean): Promise<void> => {
  let body: unknown;
  const server = await httpFixture((...[, response]) => { replyJson(response, body); });
  try {
    const client = new AwsAdminClient({ url: server.origin, token: TEST_TOKEN });
    for (body of bodies) {
      if (valid) { assert.deepEqual(await server.track<unknown>(client[method]()), body); } else { await assertSafeRejection(server.track<unknown>(client[method]())); }
    }
  } finally {
    await server.close();
  }
};

const invalidAttributes = (): unknown[] => {
  const queue = queueValue();
  const attributes = queue.details.attributes;
  const invalid: unknown[] = [];
  for (const key of Object.keys(attributes)) {
    for (const value of [30, null, '', '1.5', '1e2', '-1']) {
      invalid.push({ ...queue, details: { ...queue.details, attributes: { ...attributes, [key]: value } } });
    }
  }
  for (const [key, value] of [
    ['VisibilityTimeout', '43201'], ['DelaySeconds', '901'], ['MessageRetentionPeriod', '1209601'],
    ['MaximumMessageSize', '1023'], ['MaximumMessageSize', '1048577'], ['ReceiveMessageWaitTimeSeconds', '21'],
  ]) {
    assert.ok(key !== undefined && value !== undefined);
    invalid.push({ ...queue, details: { ...queue.details, attributes: { ...attributes, [key]: value } } });
  }
  return invalid.map(resource => ({ resources: [resource] }));
};

export const tests: readonly TestCase[] = [
  {
    name: 'AWS admin DTO boundaries: empty resources/traces and zero/max-safe counts remain valid',
    run: async (): Promise<void> => {
      await checkBodies([healthValue(0), healthValue(Number.MAX_SAFE_INTEGER)], 'health', true);
      await checkBodies([{ resources: [] }], 'resources', true);
      await checkBodies([{ traces: [] }], 'traces', true);
    },
  },
  {
    name: 'AWS admin DTO boundaries: queue names, decimal attributes and all three counts accept documented endpoints',
    run: async (): Promise<void> => {
      const minimum = queueValue('a', 'us-east-1', '000000000000');
      const maximum = queueValue('A_9-'.repeat(20), 'ap-southeast-7', '999999999999', 65535);
      const resources = [
        { ...minimum, details: { ...minimum.details, messageCounts: { available: 0, delayed: 0, inFlight: 0 }, attributes: {
          VisibilityTimeout: '0', DelaySeconds: '0', MessageRetentionPeriod: '60', MaximumMessageSize: '1024', ReceiveMessageWaitTimeSeconds: '0',
        } } },
        { ...maximum, details: { ...maximum.details, messageCounts: { available: Number.MAX_SAFE_INTEGER, delayed: Number.MAX_SAFE_INTEGER, inFlight: Number.MAX_SAFE_INTEGER }, attributes: {
          VisibilityTimeout: '43200', DelaySeconds: '900', MessageRetentionPeriod: '1209600', MaximumMessageSize: '1048576', ReceiveMessageWaitTimeSeconds: '20',
        } } },
      ];
      await checkBodies(resources.map(resource => ({ resources: [resource] })), 'resources', true);
    },
  },
  {
    name: 'AWS admin DTO boundaries: invalid queue names and single-field URLs cannot enter resources',
    run: async (): Promise<void> => {
      const queue = queueValue();
      const urls = [
        'https://127.0.0.1:4566/000000000000/us-east-1/orders',
        'http://user:pass@127.0.0.1:4566/000000000000/us-east-1/orders',
        `${queue.details.queueUrl}?private=ZXQ`, `${queue.details.queueUrl}#QZ7`,
        queue.details.queueUrl.replace('/orders', '/other'), queue.details.queueUrl.replace('/000000000000/', '/123456789012/'),
      ];
      const resources = [
        ...['', 'a'.repeat(81), 'has space', 'queue.fifo', '界'].map(name => queueValue(name)),
        ...urls.map(queueUrl => ({ ...queue, details: { ...queue.details, queueUrl } })),
      ];
      await checkBodies(resources.map(resource => ({ resources: [resource] })), 'resources', false);
    },
  },
  {
    name: 'AWS admin DTO boundaries: each decimal attribute rejects wrong scalar types, nondecimal text and out-of-range values',
    run: async (): Promise<void> => { await checkBodies(invalidAttributes(), 'resources', false); },
  },
  {
    name: 'AWS admin DTO boundaries: trace duration permits finite fractions/zero and rejects nonfinite JSON exponents',
    run: async (): Promise<void> => {
      const trace = tracesValue().traces[0];
      assert.ok(trace !== undefined);
      await checkBodies([0, 0.5, Number.MAX_VALUE].map(durationMs => ({ traces: [{ ...trace, durationMs }] })), 'traces', true);
      for (const exponent of ['1e999', '-1e999']) {
        const body = JSON.stringify({ traces: [{ ...trace, durationMs: 'EXPONENT' }] }).replace('"EXPONENT"', exponent);
        const server = await httpFixture((...[, response]) => {
          response.writeHead(200, { 'content-type': 'application/json' }); response.end(body);
        });
        try {
          await assertSafeRejection(server.track(new AwsAdminClient({ url: server.origin, token: TEST_TOKEN }).traces()));
        } finally {
          await server.close();
        }
      }
    },
  },
];
