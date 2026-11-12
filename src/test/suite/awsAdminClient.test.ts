import assert from 'node:assert/strict';
import { AwsAdminClient } from '../../cloud/adminClient';
import type { TestCase } from './harness';
import { httpFixture, replyJson } from './awsHttpFixture';
import { TEST_TOKEN, coverageValue, healthValue, queueValue, tracesValue } from './awsData';
import { assertSafeRejection, paddedHealth, RESPONSE_LIMIT, responseScenarios } from './awsAdminOracleFixture';

export const tests: readonly TestCase[] = [
  {
    name: 'AWS admin client: accepts every published coverage status and evidence kind without inventing success',
    run: async (): Promise<void> => {
      const coverage = { services: [{ service: 'sqs', operations: [
        { operation: 'CreateQueue', status: 'unsupported' }, { operation: 'GetQueueUrl', status: 'stubbed' },
        { operation: 'ListQueues', status: 'partial' }, { operation: 'DeleteQueue', status: 'verified' }, { operation: 'SendMessage', status: 'simulated' },
      ].map(operation => ({
        ...operation, testKinds: ['unit', 'protocol', 'lifecycle', 'workflow', 'differential'], limitations: ['Synthetic parser fixture'],
      })) }] };
      const server = await httpFixture((...[, response]) => { replyJson(response, coverage); });
      try {
        assert.deepEqual(await new AwsAdminClient({ url: server.origin, token: TEST_TOKEN }).coverage(), coverage);
      } finally {
        await server.close();
      }
    },
  },
  {
    name: 'AWS admin client: native HTTP routes, per-start bearer and exact mutation envelopes',
    run: async (): Promise<void> => {
      const resources = { resources: [queueValue()] };
      const replies: Readonly<Record<string, unknown>> = {
        '/health': healthValue(4), '/resources': resources, '/coverage': coverageValue(), '/traces': tracesValue(),
        '/save': { saved: true }, '/reset': { reset: true }, '/shutdown': { stopping: true },
      };
      const server = await httpFixture((request, response) => { replyJson(response, replies[request.url]); });
      try {
        const client = new AwsAdminClient({ url: server.origin, token: TEST_TOKEN });
        assert.deepEqual(await client.health(), healthValue(4));
        assert.deepEqual(await client.resources(), resources);
        assert.deepEqual(await client.coverage(), coverageValue());
        assert.deepEqual(await client.traces(), tracesValue());
        await client.save();
        await client.reset('all');
        await client.reset({ account: '123456789012', region: 'ap-southeast-7' });
        await client.shutdown();
        assert.deepEqual(server.requests.map(request => {
          const body: unknown = request.body.length === 0 ? '' : JSON.parse(request.body.toString('utf8'));
          return [request.method, request.url, body];
        }), [
          ['GET', '/health', ''], ['GET', '/resources', ''], ['GET', '/coverage', ''], ['GET', '/traces', ''],
          ['POST', '/save', {}], ['POST', '/reset', { scope: 'all' }],
          ['POST', '/reset', { scope: { account: '123456789012', region: 'ap-southeast-7' } }], ['POST', '/shutdown', {}],
        ]);
        for (const request of server.requests) {
          assert.equal(request.headers.authorization, `Bearer ${TEST_TOKEN}`);
          if (request.method === 'POST') {
            assert.match(request.headers['content-type'] ?? '', /^application\/json(?:;|$)/u);
          }
        }
      } finally {
        await server.close();
      }
    },
  },
  {
    name: 'AWS admin client: rejects invalid origins and tokens before any HTTP request',
    run: async (): Promise<void> => {
      const server = await httpFixture((...[, response]) => { replyJson(response, healthValue()); });
      try {
        const urls = [
          `${server.origin}/health`, `${server.origin}?query=1`, `${server.origin}#fragment`,
          server.origin.replace('127.0.0.1', 'user:password@127.0.0.1'),
          server.origin.replace('127.0.0.1', 'localhost'), server.origin.replace('http:', 'https:'),
        ];
        for (const url of urls) {
          await assert.rejects(async (): Promise<unknown> => await new AwsAdminClient({ url, token: TEST_TOKEN }).health());
        }
        for (const token of ['', 'x'.repeat(31), `${TEST_TOKEN}\r\nInjected: true`, `${TEST_TOKEN}\u0000`, `${TEST_TOKEN}\u007f`]) {
          await assert.rejects(async (): Promise<unknown> => await new AwsAdminClient({ url: server.origin, token }).health());
        }
        assert.equal(server.requests.length, 0);
        assert.equal(server.connections, 0, 'configuration validation must precede even opening a connection');
      } finally {
        await server.close();
      }
    },
  },
  {
    name: 'AWS admin client: non-2xx, non-JSON, truncated and oversized responses reject without response/token disclosure',
    run: async (): Promise<void> => {
      for (const reply of responseScenarios()) {
        const server = await httpFixture((...[, response]) => {
          response.writeHead(reply.status, { 'content-type': reply.type, 'content-length': Buffer.byteLength(reply.body) + reply.extra });
          response.end(reply.body);
        });
        try {
          await assertSafeRejection(server.track(new AwsAdminClient({ url: server.origin, token: TEST_TOKEN }).health()));
          assert.equal(server.requests.length, 1, reply.reason);
        } finally {
          await server.close();
        }
      }
    },
  },
  {
    name: 'AWS admin client: valid JSON exponent syntax cannot introduce a non-finite count',
    run: async (): Promise<void> => {
      const server = await httpFixture((...[, response]) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"status":"running","requestCount":1e999,"services":["sqs","sts"]}');
      });
      try {
        await assertSafeRejection(server.track(new AwsAdminClient({ url: server.origin, token: TEST_TOKEN }).health()));
      } finally {
        await server.close();
      }
    },
  },
  {
    name: 'AWS admin client: enforces the 2 MiB cap on chunked responses without a content length',
    run: async (): Promise<void> => {
      const server = await httpFixture((...[, response]) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write(paddedHealth(RESPONSE_LIMIT));
        response.end(' ');
      });
      try {
        await assertSafeRejection(server.track(new AwsAdminClient({ url: server.origin, token: TEST_TOKEN }).health()));
      } finally {
        await server.close();
      }
    },
  },
  {
    name: 'AWS admin client: refuses redirects without forwarding the bearer token',
    run: async (): Promise<void> => {
      const target = await httpFixture((...[, response]) => { replyJson(response, healthValue()); });
      const redirect = await httpFixture((...[, response]) => {
        response.writeHead(302, { location: `${target.origin}/health` });
        response.end(TEST_TOKEN);
      });
      try {
        await assertSafeRejection(redirect.track(new AwsAdminClient({ url: redirect.origin, token: TEST_TOKEN }).health()));
        assert.equal(target.requests.length, 0);
      } finally {
        await redirect.close();
        await target.close();
      }
    },
  },
  {
    name: 'AWS admin client: five-second wall-clock deadline also bounds a response that keeps sending bytes',
    run: async (): Promise<void> => {
      const server = await httpFixture((...[, response]) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write(' ');
        const timer = setInterval(() => { response.write(' '); }, 100);
        response.once('close', () => { clearInterval(timer); });
      });
      try {
        const started = Date.now();
        await assertSafeRejection(server.track(new AwsAdminClient({ url: server.origin, token: TEST_TOKEN }).health()));
        assert.ok(Date.now() - started < 6_500, 'an idle timeout is not a request deadline');
      } finally {
        await server.close();
      }
    },
  },
  {
    name: 'AWS admin client: an otherwise-valid health DTO at exactly the 2 MiB byte limit is accepted',
    run: async (): Promise<void> => {
      const body = paddedHealth(RESPONSE_LIMIT);
      const server = await httpFixture((...[, response]) => {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        response.end(body);
      });
      try {
        assert.deepEqual(await server.track(new AwsAdminClient({ url: server.origin, token: TEST_TOKEN }).health()), healthValue());
      } finally {
        await server.close();
      }
    },
  },
];
