import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { AwsHostBackend, HostBackend } from '../../backend/hostBackend';
import { AwsAdminClient } from '../../cloud/adminClient';
import { ReviewerClient } from '../../review/reviewerClient';
import type { TestCase } from './harness';
import { bounded, freePort } from './awsHttpFixture';
import { TEST_TOKEN } from './awsData';

const eventually = async (probe: () => Promise<unknown>): Promise<void> => {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await probe();
      return;
    } catch (error: unknown) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise<void>(resolve => { setTimeout(resolve, 100); });
    }
  }
};

const assertPortReleased = async (port: number): Promise<void> => {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } finally {
    await new Promise<void>(resolve => { server.close(() => { resolve(); }); });
  }
};

export const tests: readonly TestCase[] = [
  {
    name: 'AWS real host boundary: fixed service entry starts, authenticates, releases ports/state lock, and restarts',
    run: async (): Promise<void> => {
      const extension = vscode.extensions.getExtension<unknown>('division4studios.malt');
      assert.ok(extension !== undefined);
      const root = await mkdtemp(join(tmpdir(), 'malt-aws-host-'));
      const logs: string[] = [];
      const host = new AwsHostBackend({ extensionRoot: extension.extensionPath, log: (line: string): void => { logs.push(line); } });
      try {
        const stateDirectory = join(root, '.malt', 'aws');
        await mkdir(stateDirectory, { recursive: true });
        const options = { workspaceRoot: root, stateDirectory, bindAddress: '127.0.0.1', port: await freePort(), adminPort: await freePort(), token: TEST_TOKEN };
        const first = await bounded(host.start(options), 15_000);
        assert.equal(first.gatewayUrl, `http://127.0.0.1:${String(options.port)}`);
        assert.equal(first.adminUrl, `http://127.0.0.1:${String(options.adminPort)}`);
        const client = new AwsAdminClient({ url: first.adminUrl, token: TEST_TOKEN });
        await eventually(async (): Promise<unknown> => await client.health());
        await assert.rejects(new AwsAdminClient({ url: first.adminUrl, token: `${TEST_TOKEN}-wrong` }).health());
        await bounded(host.stop(), 10_000);
        await assertPortReleased(options.port);
        await assertPortReleased(options.adminPort);
        const next = await bounded(host.start({ ...options, token: `${TEST_TOKEN}-next` }), 15_000);
        await eventually(async (): Promise<unknown> => await new AwsAdminClient({ url: next.adminUrl, token: `${TEST_TOKEN}-next` }).health());
        assert.ok(!logs.join('\n').includes(TEST_TOKEN));
      } finally {
        await bounded(host.stop(), 10_000);
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'AWS host regression: original reviewer startup and shutdown still serve authenticated health without model calls',
    run: async (): Promise<void> => {
      const extension = vscode.extensions.getExtension<unknown>('division4studios.malt');
      assert.ok(extension !== undefined);
      const root = await mkdtemp(join(tmpdir(), 'malt-aws-reviewer-regression-'));
      const reviewer = new HostBackend(extension.extensionPath, 'unused-no-model-calls', (): void => undefined);
      const port = await freePort();
      try {
        assert.equal(await reviewer.isAvailable(), true);
        await reviewer.start({ workspaceRoot: root, port, token: TEST_TOKEN, env: {}, agents: 2 });
        const client = new ReviewerClient({ port, token: TEST_TOKEN });
        await eventually(async (): Promise<unknown> => await client.health());
        assert.equal(await reviewer.isRunning(), true);
        await bounded(reviewer.stop(), 10_000);
        assert.equal(await reviewer.isRunning(), false);
        await assertPortReleased(port);
      } finally {
        await bounded(reviewer.stop(), 10_000);
        await rm(root, { recursive: true, force: true });
      }
    },
  },
];
