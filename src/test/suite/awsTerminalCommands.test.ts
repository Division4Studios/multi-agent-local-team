import assert from 'node:assert/strict';
import type { AwsEndpoint } from '../../cloud/backend';
import { terminalEnvironment } from '../../cloud/terminal';
import type { TestCase } from './harness';
import { deferred, waitFor } from './testUtils';
import { CommandFixture } from './awsCommandFixture';
import { drain, fulfilled, observe } from './awsAsyncFixture';
import { TEST_ENDPOINT, healthValue, withAws } from './awsTestFixtures';
import type { Health } from './awsTestFixtures';

export const tests: readonly TestCase[] = [
  {
    name: 'AWS terminal command: waits for a healthy start then creates a named native terminal with local env',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const commands = new CommandFixture(f);
        commands.current = { ...f.request, region: 'eu-west-3' };
        const gate = deferred<AwsEndpoint>();
        const health = deferred<Health>();
        f.host.onStart = async (): Promise<AwsEndpoint> => await gate.promise;
        f.api.onHealth = async (): Promise<Health> => await health.promise;
        const opening = observe(commands.run('malt.aws.openTerminal'));
        try {
          await waitFor(() => f.host.starts.length === 1, 'terminal requested gateway start');
          assert.equal(commands.terminals.length, 0);
          gate.resolve(TEST_ENDPOINT);
          await waitFor(() => f.api.healthCalls === 1, 'initial health is pending');
          assert.equal(f.manager.client, undefined);
          assert.equal(f.manager.status.state, 'starting');
          assert.equal(commands.terminals.length, 0);
          assert.equal(opening.settled, false);
          health.resolve(healthValue());
          await fulfilled(opening);
        } finally {
          gate.resolve(TEST_ENDPOINT);
          health.resolve(healthValue());
          await drain([opening]);
        }
        const terminal = commands.terminals[0];
        assert.ok(terminal !== undefined);
        assert.equal(commands.terminals.length, 1);
        assert.equal(terminal.name, 'MALT Local AWS');
        assert.deepEqual(terminal.env, terminalEnvironment(TEST_ENDPOINT.gatewayUrl, 'eu-west-3'));
        assert.ok(f.calls.indexOf('health') < f.calls.indexOf('terminal'));
        assert.equal(commands.errors.length, 0);
      });
    },
  },
  {
    name: 'AWS terminal command: running gateway is reused; startup failure does not create a misleading terminal',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const commands = new CommandFixture(f);
        await f.manager.start(f.request);
        await commands.run('malt.aws.openTerminal');
        await commands.run('malt.aws.openTerminal');
        assert.equal(f.host.starts.length, 1);
        assert.equal(commands.terminals.length, 2);
        await f.manager.stop();
        f.host.onStart = async (): Promise<never> => await Promise.reject(new Error('startup unavailable'));
        await commands.run('malt.aws.openTerminal');
        assert.equal(commands.terminals.length, 2);
        assert.equal(commands.errors.length, 1);
      });
    },
  },
  {
    name: 'AWS terminal command: initial-health rejection cleans the live backend and never publishes a terminal',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const commands = new CommandFixture(f);
        const health = deferred<undefined>();
        f.api.onHealth = async (): Promise<never> => { await health.promise; throw new Error('health failed'); };
        const opening = observe(commands.run('malt.aws.openTerminal'));
        try {
          await waitFor(() => f.api.healthCalls === 1, 'initial health pending');
          assert.ok(f.host.live.has(1));
          assert.equal(f.manager.client, undefined);
          assert.equal(commands.terminals.length, 0);
          health.resolve(undefined);
          await fulfilled(opening);
          assert.equal(commands.errors.length, 1);
          assert.equal(commands.terminals.length, 0);
          assert.equal(f.manager.client, undefined);
          assert.equal(f.manager.status.state, 'error');
          assert.equal(f.host.live.size, 0);
        } finally {
          health.resolve(undefined);
          await drain([opening]);
        }
      });
    },
  },
];
