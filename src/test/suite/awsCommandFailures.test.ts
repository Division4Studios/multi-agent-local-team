import assert from 'node:assert/strict';
import { createAwsCommandHandlers } from '../../cloud/commands';
import type { AwsCommandDependencies } from '../../cloud/commands';
import type { TestCase } from './harness';
import { AWS_COMMANDS, CommandFixture } from './awsCommandFixture';
import { TEST_ENDPOINT, TEST_TOKEN, queueValue, startRequest } from './awsData';
import { assertSafeError } from './awsAdminOracleFixture';
import { drain, fulfilled, observe } from './awsAsyncFixture';
import { withAws } from './awsTestFixtures';
import { deferred, waitFor } from './testUtils';

const failing = (calls: string[], name: string): (() => never) => (): never => {
  calls.push(name);
  throw new Error(`ZXQ QZ7 ${TEST_TOKEN}\n    at synthetic-boundary`);
};

/** Every failure is emitted at a direct structural dependency, with no manager sanitization. */
const dependencies = (calls: string[], errors: string[]): AwsCommandDependencies => ({
  manager: {
    status: { state: 'running', requestCount: 0, detail: 'running', endpoint: TEST_ENDPOINT, backend: 'host', region: 'us-east-1' },
    start: failing(calls, 'start'), stop: failing(calls, 'stop'),
    client: {
      health: failing(calls, 'health'), resources: failing(calls, 'resources'), coverage: failing(calls, 'coverage'),
      traces: failing(calls, 'traces'), save: failing(calls, 'save'), reset: failing(calls, 'reset'), shutdown: failing(calls, 'shutdown'),
    },
  },
  startRequest: () => startRequest('structural-workspace'),
  confirmReset: async (): Promise<boolean> => await Promise.resolve(true),
  refresh: failing(calls, 'refresh'), showDocument: failing(calls, 'document'), createTerminal: failing(calls, 'terminal'),
  onUserFocus: (): void => { calls.push('focus'); },
  reportError: (message: string): void => { errors.push(message); },
});

export const tests: readonly TestCase[] = [
  {
    name: 'AWS command wrapper: every public handler catches direct structural exceptions and strips raw excerpts/stacks',
    run: async (): Promise<void> => {
      for (const id of AWS_COMMANDS) {
        const calls: string[] = [];
        const errors: string[] = [];
        const handler = createAwsCommandHandlers(dependencies(calls, errors)).get(id);
        assert.ok(handler !== undefined);
        await assert.doesNotReject(handler(queueValue(), 'ZXQ-argument'));
        assert.equal(calls[0], 'focus');
        assert.equal(calls.length, 2, 'a direct throwing dependency must actually be reached');
        assert.equal(errors.length, 1);
        assertSafeError(new Error(errors[0]));
        assert.doesNotMatch(errors[0] ?? '', /\n\s+at /u);
      }
    },
  },
  {
    name: 'AWS command wrapper: failed reset is awaited, reported and never followed by refresh',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        const commands = new CommandFixture(f);
        commands.allowReset = true;
        const gate = deferred<undefined>();
        f.api.onReset = async (): Promise<never> => { await gate.promise; throw new Error('ZXQ reset QZ7'); };
        commands.resetObservations();
        const resetting = observe(commands.run('malt.aws.reset'));
        try {
          await waitFor(() => f.calls.includes('reset:"all"'), 'reset entered');
          assert.equal(resetting.settled, false);
          assert.ok(!f.calls.includes('refresh'));
          gate.resolve(undefined);
          await fulfilled(resetting);
          assert.equal(commands.errors.length, 1);
          assertSafeError(new Error(commands.errors[0]));
          assert.ok(!f.calls.includes('refresh'));
        } finally {
          gate.resolve(undefined);
          await drain([resetting]);
          f.api.onReset = undefined;
        }
      });
    },
  },
];
