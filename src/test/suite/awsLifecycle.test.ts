import assert from 'node:assert/strict';
import type { AwsEndpoint } from '../../cloud/backend';
import type { TestCase } from './harness';
import { deferred, waitFor } from './testUtils';
import { bounded } from './awsHttpFixture';
import { drain, fulfilled, observe, rejected } from './awsAsyncFixture';
import type { Observed } from './awsAsyncFixture';
import { assertRemoved } from './awsBackendFixture';
import { FakeAdmin, TEST_ENDPOINT, healthValue, withAws } from './awsTestFixtures';
import type { Health } from './awsTestFixtures';

export const tests: readonly TestCase[] = [
  {
    name: 'AWS lifecycle: stop invalidates a pending start immediately and cleans up its late backend',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const gate = deferred<AwsEndpoint>();
        f.host.onStart = async (): Promise<AwsEndpoint> => await gate.promise;
        const states: string[] = [];
        const subscription = f.manager.onDidChangeStatus(status => { states.push(status.state); });
        const starting = observe(f.manager.start(f.request));
        const pending: Observed<unknown>[] = [starting];
        try {
          await waitFor(() => f.host.starts.length === 1, 'backend start entered');
          const stopping = observe(f.manager.stop());
          pending.push(stopping);
          assert.equal(f.manager.client, undefined);
          gate.resolve(TEST_ENDPOINT);
          await rejected(starting);
          await fulfilled(stopping);
          await waitFor(() => f.host.removed.includes(1), 'late resource actually removed');
          assertRemoved(f.host, 1);
          assert.equal(f.host.live.size, 0);
          assert.equal(f.manager.status.state, 'stopped');
          assert.ok(!states.includes('running'));
        } finally {
          gate.resolve(TEST_ENDPOINT);
          await drain(pending);
          subscription.dispose();
        }
      });
    },
  },
  {
    name: 'AWS lifecycle: disposal arranges cleanup even when startup resolves after disposal',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const gate = deferred<AwsEndpoint>();
        f.host.onStart = async (): Promise<AwsEndpoint> => await gate.promise;
        const starting = observe(f.manager.start(f.request));
        try {
          await waitFor(() => f.host.starts.length === 1, 'backend start entered');
          f.dispose();
          gate.resolve(TEST_ENDPOINT);
          await rejected(starting);
          await waitFor(() => f.host.removed.includes(1), 'late disposed resource actually removed');
          assertRemoved(f.host, 1);
          assert.equal(f.host.live.size, 0);
          assert.equal(f.manager.client, undefined);
          assert.notEqual(f.manager.status.state, 'running');
        } finally {
          gate.resolve(TEST_ENDPOINT);
          await drain([starting]);
        }
      });
    },
  },
  {
    name: 'AWS lifecycle: failed backend start and failed initial health both clean up the selected backend',
    run: async (): Promise<void> => {
      for (const phase of ['backend', 'health']) {
        await withAws(async f => {
          const fail = async (): Promise<never> => await Promise.reject(new Error('synthetic startup failure'));
          if (phase === 'backend') {
            f.host.onStart = fail;
          } else {
            f.api.onHealth = fail;
          }
          await assert.rejects(f.manager.start(f.request));
          assert.ok(f.host.stops > 0);
          assert.equal(f.host.live.size, 0);
          assert.equal(f.docker.stops, 0);
          assert.equal(f.manager.client, undefined);
          assert.equal(f.manager.status.state, 'error');
        });
      }
    },
  },
  {
    name: 'AWS lifecycle: shutdown precedes backend cleanup; failure still cleans up and surfaces error',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        f.calls.length = 0;
        f.api.onShutdown = async (): Promise<void> => { await Promise.reject(new Error('shutdown refused')); };
        const stopping = observe(f.manager.stop());
        try {
          await drain([stopping]);
          assert.ok(f.calls.includes('shutdown'));
          assert.ok(f.calls.indexOf('shutdown') < f.calls.indexOf('host:stop'));
          assertRemoved(f.host, 1);
          assert.equal(f.manager.status.state, 'error');
          assert.equal(f.manager.client, undefined);
        } finally {
          await drain([stopping]);
          f.api.onShutdown = undefined;
        }
      });
    },
  },
  {
    name: 'AWS lifecycle: backend cleanup failure cannot be reported as stopped',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        f.host.onStop = async (): Promise<void> => { await Promise.reject(new Error('owned backend still running')); };
        try {
          await f.manager.stop().catch(() => undefined);
          assert.equal(f.manager.status.state, 'error');
          assert.equal(f.manager.client, undefined);
        } finally {
          f.host.onStop = undefined;
        }
      });
    },
  },
  {
    name: 'AWS lifecycle: old successful health cannot overwrite a restarted instance',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        const gate = deferred<Health>();
        f.api.onHealth = async (): Promise<Health> => await gate.promise;
        const checking = observe(f.manager.checkHealth());
        try {
          await waitFor(() => f.api.healthCalls === 2, 'old health entered');
          await bounded(f.manager.stop());
          f.api = new FakeAdmin(f.calls);
          f.api.onHealth = async (): Promise<Health> => await Promise.resolve(healthValue(7));
          await f.manager.start(f.request);
          const before = { ...f.manager.status };
          gate.resolve(healthValue(900));
          await drain([checking]);
          assert.deepEqual(f.manager.status, before);
          assert.equal(f.manager.status.requestCount, 7);
        } finally {
          gate.resolve(healthValue(900));
          await drain([checking]);
        }
      });
    },
  },
  {
    name: 'AWS lifecycle: old failed health cannot mark a restarted instance unhealthy',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        const gate = deferred<undefined>();
        f.api.onHealth = async (): Promise<Health> => {
          await gate.promise;
          throw new Error('old health failure');
        };
        const checking = observe(f.manager.checkHealth());
        try {
          await waitFor(() => f.api.healthCalls === 2, 'old health entered');
          await bounded(f.manager.stop());
          f.api = new FakeAdmin(f.calls);
          await f.manager.start(f.request);
          const before = { ...f.manager.status };
          gate.resolve(undefined);
          await drain([checking]);
          assert.deepEqual(f.manager.status, before);
        } finally {
          gate.resolve(undefined);
          await drain([checking]);
        }
      });
    },
  },
  {
    name: 'AWS lifecycle: explicit health updates count, marks failure unhealthy, and drops stopped client access',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        f.api.onHealth = async (): Promise<Health> => await Promise.resolve(healthValue(12));
        await f.manager.checkHealth();
        assert.equal(f.manager.status.requestCount, 12);
        f.api.onHealth = async (): Promise<Health> => await Promise.reject(new Error('unreachable'));
        await f.manager.checkHealth().catch(() => undefined);
        assert.equal(f.manager.status.state, 'unhealthy');
        assert.equal(f.manager.client, undefined, 'public client is available only while running');
        f.api.onHealth = async (): Promise<Health> => await Promise.resolve(healthValue());
        await f.manager.stop();
        assert.equal(f.manager.client, undefined);
      });
    },
  },
  {
    name: 'AWS lifecycle: each start uses a fresh in-memory token absent from logs and public status',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        await f.manager.stop();
        await f.manager.start(f.request);
        const tokens = f.host.starts.map(options => options.token);
        assert.equal(tokens.length, 2);
        assert.equal(new Set(tokens).size, 2);
        for (const token of tokens) {
          assert.ok(token.length >= 32);
          for (let index = 0; index < token.length; index += 1) {
            assert.ok(token.charCodeAt(index) >= 32 && token.charCodeAt(index) !== 127);
          }
          assert.ok(!f.logs.join('\n').includes(token));
          assert.ok(!JSON.stringify(f.manager.status).includes(token));
        }
      });
    },
  },
  {
    name: 'AWS lifecycle: periodic health runs at ten seconds and stops scheduling after stop',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        const started = Date.now();
        await waitFor(() => f.api.healthCalls >= 2, 'ten-second health check', 12_500);
        assert.ok(Date.now() - started >= 9_000, 'not an accidental fast polling loop');
        await f.manager.stop();
        const stoppedCalls = f.api.healthCalls;
        await new Promise<void>(resolve => { setTimeout(resolve, 10_500); });
        assert.equal(f.api.healthCalls, stoppedCalls);
      });
    },
  },
];
