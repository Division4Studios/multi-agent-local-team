import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { scanStream } from '../../review/scanStream';
import type { TestCase } from './harness';

const RESULT = { rules: [], gaps: [], sources: [], modules: [], warnings: [] };

const withResponse = async (body: string, check: (port: number) => Promise<void>): Promise<void> => {
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    response.end(body);
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    await check(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => { server.close((error) => { if (error !== undefined) { reject(error); } else { resolve(); } }); });
  }
};

export const tests: readonly TestCase[] = [
  {
    name: 'scan stream never accepts a result after a malformed or failed event in the same response',
    run: async (): Promise<void> => {
      for (const failed of ['{"error":"scan failed"}', 'not-json', '{"progress":{"stage":"invented","state":"complete"}}']) {
        await withResponse(`${failed}\n${JSON.stringify({ result: RESULT })}\n`, async (port) => {
          await assert.rejects(scanStream({ port, token: 'test' }, () => undefined));
        });
      }
    },
  },
  {
    name: 'scan stream accepts heartbeats and a final unterminated result, rejects missing results',
    run: async (): Promise<void> => {
      await withResponse(`\n${JSON.stringify({ result: RESULT })}`, async (port) => {
        assert.deepEqual(await scanStream({ port, token: 'test' }, () => undefined), RESULT);
      });
      await withResponse('\n', async (port) => {
        await assert.rejects(scanStream({ port, token: 'test' }, () => undefined), /before returning results/u);
      });
    },
  },
];
