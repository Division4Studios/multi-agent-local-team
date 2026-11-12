import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import type { AwsStatus } from '../../cloud/manager';
import type { TestCase } from './harness';
import { TEST_ENDPOINT, healthValue, withAws } from './awsTestFixtures';

const assertStatusShape = (status: AwsStatus): void => {
  const detail: string = status.detail;
  const gateway: string | undefined = status.endpoint?.gatewayUrl;
  const admin: string | undefined = status.endpoint?.adminUrl;
  assert.equal(typeof detail, 'string');
  assert.ok(Number.isSafeInteger(status.requestCount) && status.requestCount >= 0);
  assert.ok(['stopped', 'starting', 'running', 'stopping', 'unhealthy', 'error'].includes(status.state));
  if (status.endpoint !== undefined) {
    assert.equal(typeof gateway, 'string');
    assert.equal(typeof admin, 'string');
  }
};

export const tests: readonly TestCase[] = [
  {
    name: 'AWS supplement status: manager status and events use AwsStatus with the complete typed endpoint pair',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const events: AwsStatus[] = [];
        const event: vscode.Event<AwsStatus> = f.manager.onDidChangeStatus;
        const listener = event(status => { events.push({ ...status }); });
        try {
          assertStatusShape(f.manager.status);
          f.api.onHealth = async (): Promise<ReturnType<typeof healthValue>> => await Promise.resolve(healthValue(37));
          await f.manager.start(f.request);
          const status: AwsStatus = f.manager.status;
          assert.deepEqual(status.endpoint, TEST_ENDPOINT);
          assert.equal(status.backend, 'host');
          assert.equal(status.region, 'us-east-1');
          assert.equal(status.requestCount, 37);
          assert.ok(events.some(value => value.state === 'running' && value.endpoint?.adminUrl === TEST_ENDPOINT.adminUrl));
          await f.manager.stop();
          assert.ok(events.some(value => value.state === 'stopped'));
          for (const value of events) { assertStatusShape(value); }
        } finally {
          listener.dispose();
        }
      });
    },
  },
  {
    name: 'AWS supplement status: failure detail is human-readable text and never exposes the per-start admin token',
    run: async (): Promise<void> => {
      await withAws(async f => {
        f.host.onStart = async (options): Promise<never> => await Promise.reject(new Error(`backend failure ${options.token}`));
        await assert.rejects(f.manager.start(f.request));
        const status: AwsStatus = f.manager.status;
        assertStatusShape(status);
        assert.equal(status.state, 'error');
        assert.ok(status.detail.trim().length > 0);
        const start = f.host.starts[0];
        assert.ok(start !== undefined);
        assert.ok(!status.detail.includes(start.token));
      });
    },
  },
];
