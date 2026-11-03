import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createReviewerServer } from '../../reviewer/server';
import { ReviewService } from '../../reviewer/service';
import type { ReviewProvider, StructuredCall } from '../../reviewer/providers/provider';
import { ReviewerClient } from '../../review/reviewerClient';
import type { TestCase } from './harness';

const TOKEN = 'test-token-0123456789';
const REVIEW = { verdict: 'pass', summary: 'ok', what: 'w', why: 'y', necessity: 'n', checks: [] };

/** Fake model: records each call and answers with a fixed review or rule set. */
const createFakeProvider = (calls: StructuredCall[]): ReviewProvider => ({
  name: 'fake',
  callStructured: async (call: StructuredCall): Promise<unknown> => {
    calls.push(call);
    const rule = { id: 'r1', title: 'Rule', check: 'Ok?', category: 'style', source: 'CLAUDE.md' };
    return await Promise.resolve(call.timeoutMs > 200_000 ? { rules: [rule] } : REVIEW);
  },
});

const startServer = async (calls: StructuredCall[]): Promise<{ server: Server; port: number }> => {
  const root = await mkdtemp(join(tmpdir(), 'malt-test-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'const a = 1;\nconst b = 2;\n');
  await writeFile(join(root, 'CLAUDE.md'), '# Rules\nUse camelCase.\n');
  const service = new ReviewService({ workspaceRoot: root, reviewModel: 'm', standardsModel: 's' }, createFakeProvider(calls));
  const server = createReviewerServer(service, TOKEN);
  await new Promise<void>((resolvePromise) => {
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  return { server, port: typeof address === 'object' && address !== null ? address.port : 0 };
};

const withServer = async (test: (port: number, calls: StructuredCall[]) => Promise<void>): Promise<void> => {
  const calls: StructuredCall[] = [];
  const { server, port } = await startServer(calls);
  try {
    await test(port, calls);
  } finally {
    server.close();
  }
};

export const tests: readonly TestCase[] = [
  {
    name: 'reviewer server: rejects requests without the token',
    run: async (): Promise<void> => {
      await withServer(async (port) => {
        await assert.rejects(new ReviewerClient({ port, token: 'wrong' }).health(), /401/u);
      });
    },
  },
  {
    name: 'reviewer server: health, review and standards scan round-trip',
    run: async (): Promise<void> => {
      await withServer(async (port, calls) => {
        const client = new ReviewerClient({ port, token: TOKEN });
        assert.deepEqual(await client.health(), { ok: true, protocolVersion: 1, provider: 'fake', rulesLoaded: 0 });
        const review = await client.review({ filePath: 'src/a.ts', startLine: 1, endLine: 1, patch: '@@\n+const b = 2;' });
        assert.equal(review.verdict, 'pass');
        const [reviewCall] = calls;
        if (reviewCall === undefined) {
          assert.fail('expected a provider call');
        }
        assert.ok(reviewCall.userPrompt.includes('2| const b = 2;'));
        assert.ok(reviewCall.systemPrompt.includes('[no-dead-code]'));
        const scan = await client.scanStandards();
        assert.deepEqual(scan.sources, ['CLAUDE.md']);
        assert.equal(scan.rules.length, 1);
      });
    },
  },
  {
    name: 'reviewer server: refuses paths outside the workspace',
    run: async (): Promise<void> => {
      await withServer(async (port, calls) => {
        const client = new ReviewerClient({ port, token: TOKEN });
        await assert.rejects(client.review({ filePath: '../../etc/passwd', startLine: 0, endLine: 0, patch: '@@' }), /outside the workspace/u);
        assert.equal(calls.length, 0);
      });
    },
  },
];
