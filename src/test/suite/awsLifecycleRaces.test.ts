import assert from 'node:assert/strict';
import type { AwsEndpoint } from '../../cloud/backend';
import type { TestCase } from './harness';
import { drain, fulfilled, observe, rejected } from './awsAsyncFixture';
import type { Observed } from './awsAsyncFixture';
import { assertRemoved } from './awsBackendFixture';
import { TEST_ENDPOINT, healthValue, withAws } from './awsTestFixtures';
import type { Health } from './awsTestFixtures';
import { deferred, waitFor } from './testUtils';

export const tests: readonly TestCase[] = [
  {
    name: 'AWS lifecycle: start-stop-start calls serialize cleanup before the replacement backend',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const gate = deferred<AwsEndpoint>();
        const cleanup = deferred<undefined>();
        f.host.onStart = async (): Promise<AwsEndpoint> => f.host.starts.length === 1 ? await gate.promise : await Promise.resolve(TEST_ENDPOINT);
        f.host.onStop = async (): Promise<void> => { await cleanup.promise; };
        const starting = observe(f.manager.start(f.request));
        const pending: Observed<unknown>[] = [starting];
        try {
          await waitFor(() => f.host.starts.length === 1, 'first start entered');
          const stopping = observe(f.manager.stop());
          const restarting = observe(f.manager.start({ ...f.request, port: 4567 }));
          pending.push(stopping, restarting);
          assert.equal(f.host.starts.length, 1, 'the replacement cannot overtake pending owned startup');
          gate.resolve(TEST_ENDPOINT);
          await waitFor(() => f.host.cleanupTargets.some(targets => targets.includes(1)), 'cleanup acquired the late resource');
          assert.equal(f.host.starts.length, 1, 'replacement must await completed removal');
          assert.equal(restarting.settled, false);
          assert.ok(f.host.live.has(1));
          cleanup.resolve(undefined);
          await rejected(starting);
          await fulfilled(stopping);
          await fulfilled(restarting);
          assert.equal(f.host.starts.length, 2);
          assertRemoved(f.host, 1);
          assert.deepEqual([...f.host.live], [2]);
          assert.equal(f.manager.status.state, 'running');
          assert.equal(f.manager.client, f.api);
        } finally {
          gate.resolve(TEST_ENDPOINT);
          cleanup.resolve(undefined);
          await drain(pending);
          f.host.onStop = undefined;
        }
      });
    },
  },
  {
    name: 'AWS lifecycle: stop during initial health invalidates late health before publishing the client',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const gate = deferred<Health>();
        f.api.onHealth = async (): Promise<Health> => await gate.promise;
        const states: string[] = [];
        const listener = f.manager.onDidChangeStatus(status => { states.push(status.state); });
        const starting = observe(f.manager.start(f.request));
        const pending: Observed<unknown>[] = [starting];
        try {
          await waitFor(() => f.api.healthCalls === 1, 'initial health entered');
          assert.equal(f.manager.client, undefined);
          assert.equal(f.manager.status.state, 'starting');
          assert.ok(!states.includes('running'));
          const stopping = observe(f.manager.stop());
          pending.push(stopping);
          gate.resolve(healthValue(77));
          await rejected(starting);
          await fulfilled(stopping);
          assert.ok(!states.includes('running'));
          assert.equal(f.manager.client, undefined);
          assert.equal(f.manager.status.state, 'stopped');
          assert.equal(f.host.live.size, 0);
          assertRemoved(f.host, 1);
        } finally {
          gate.resolve(healthValue(77));
          await drain(pending);
          listener.dispose();
        }
      });
    },
  },
  {
    name: 'AWS lifecycle: successful shutdown and backend cleanup must each complete before stop settles',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        const shutdown = deferred<undefined>();
        const cleanup = deferred<undefined>();
        f.api.onShutdown = async (): Promise<void> => { await shutdown.promise; };
        f.host.onStop = async (): Promise<void> => { await cleanup.promise; };
        const stopping = observe(f.manager.stop());
        try {
          await waitFor(() => f.calls.includes('shutdown'), 'graceful shutdown entered');
          assert.equal(f.host.stops, 0, 'pending save/shutdown must prevent backend cleanup');
          assert.equal(stopping.settled, false);
          assert.ok(f.host.live.has(1));
          shutdown.resolve(undefined);
          await waitFor(() => f.host.stops === 1, 'backend cleanup entered');
          assert.equal(stopping.settled, false);
          assert.notEqual(f.manager.status.state, 'stopped');
          assert.ok(f.host.live.has(1));
          cleanup.resolve(undefined);
          await fulfilled(stopping);
          assert.equal(f.host.live.size, 0);
          assert.equal(f.manager.status.state, 'stopped');
        } finally {
          shutdown.resolve(undefined);
          cleanup.resolve(undefined);
          await drain([stopping]);
          f.api.onShutdown = undefined;
          f.host.onStop = undefined;
        }
      });
    },
  },
];
