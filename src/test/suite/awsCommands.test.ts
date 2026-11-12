import assert from 'node:assert/strict';
import type { TestCase } from './harness';
import { deferred, waitFor } from './testUtils';
import { AWS_COMMANDS, CommandFixture } from './awsCommandFixture';
import { drain, fulfilled, observe } from './awsAsyncFixture';
import { coverageValue, queueValue, tracesValue, withAws } from './awsTestFixtures';

export const tests: readonly TestCase[] = [
  {
    name: 'AWS commands: exactly nine public handlers, all reject absent or untrusted workspaces before dispatch',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const commands = new CommandFixture(f);
        assert.deepEqual(new Set(commands.handlers.keys()), new Set(AWS_COMMANDS));
        for (const request of [undefined, { ...f.request, trusted: false }]) {
          commands.current = request;
          for (const id of AWS_COMMANDS) {
            commands.resetObservations();
            await commands.run(id, queueValue());
            assert.deepEqual(f.calls, ['focus'], `${id} must note user activity but dispatch nothing`);
            assert.ok(commands.reads > 0);
            assert.equal(commands.errors.length, 1);
            assert.match(commands.errors[0] ?? '', /workspace|trust/iu);
          }
        }
        assert.equal(commands.terminals.length + commands.documents.length, 0);
      });
    },
  },
  {
    name: 'AWS commands: start, stop and refresh use lifecycle/refresh boundaries and record user focus',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const commands = new CommandFixture(f);
        await commands.run('malt.aws.start');
        assert.equal(f.host.starts.length, 1);
        assert.equal(f.calls[0], 'focus');
        commands.resetObservations();
        await commands.run('malt.aws.refresh');
        assert.deepEqual(f.calls, ['focus', 'refresh']);
        commands.resetObservations();
        await commands.run('malt.aws.stop');
        assert.equal(f.calls[0], 'focus');
        assert.equal(f.manager.status.state, 'stopped');
        assert.equal(commands.errors.length, 0);
      });
    },
  },
  {
    name: 'AWS commands: reset refusal has no side effects, acceptance waits for reset before refresh',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        const commands = new CommandFixture(f);
        commands.resetObservations();
        await commands.run('malt.aws.reset');
        assert.deepEqual(f.calls, ['focus', 'confirm-reset']);
        commands.allowReset = true;
        const gate = deferred<undefined>();
        f.api.onReset = async (): Promise<void> => { await gate.promise; };
        commands.resetObservations();
        const resetting = observe(commands.run('malt.aws.reset'));
        try {
          await waitFor(() => f.calls.includes('reset:"all"'), 'confirmed reset reached admin API');
          assert.ok(!f.calls.includes('refresh'));
        } finally {
          gate.resolve(undefined);
          await drain([resetting]);
        }
        await fulfilled(resetting);
        assert.deepEqual(f.calls, ['focus', 'confirm-reset', 'reset:"all"', 'refresh']);
      });
    },
  },
  {
    name: 'AWS commands: restart awaits cleanup then rereads settings before its new start',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        const commands = new CommandFixture(f);
        const gate = deferred<undefined>();
        f.host.onStop = async (): Promise<void> => { await gate.promise; };
        const restarting = observe(commands.run('malt.aws.restart'));
        try {
          await waitFor(() => f.host.stops > 0, 'restart entered stop');
          assert.equal(f.host.starts.length, 1);
          commands.current = { ...f.request, port: 4567, region: 'eu-west-3' };
        } finally {
          gate.resolve(undefined);
          await drain([restarting]);
          f.host.onStop = undefined;
        }
        await fulfilled(restarting);
        assert.ok(commands.reads >= 2);
        assert.equal(f.host.starts[1]?.port, 4567);
        assert.equal(f.manager.status.region, 'eu-west-3');
        assert.equal(commands.errors.length, 0);
        f.host.onStop = undefined;
      });
    },
  },
  {
    name: 'AWS commands: losing trust during restart prevents its second start',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        const commands = new CommandFixture(f);
        f.host.onStop = async (): Promise<void> => {
          commands.current = { ...f.request, trusted: false };
          await Promise.resolve();
        };
        await commands.run('malt.aws.restart');
        assert.equal(f.host.starts.length, 1);
        assert.equal(commands.errors.length, 1);
        assert.equal(f.manager.status.state, 'stopped');
      });
    },
  },
  {
    name: 'AWS commands: admin document commands require a running client and forward parsed envelopes',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const commands = new CommandFixture(f);
        for (const id of ['malt.aws.showCoverage', 'malt.aws.showTraces', 'malt.aws.reset']) {
          commands.allowReset = true;
          await commands.run(id);
        }
        assert.equal(commands.documents.length, 0);
        assert.equal(commands.errors.length, 3);
        assert.ok(!f.calls.includes('coverage') && !f.calls.includes('traces') && !f.calls.includes('reset:"all"'));
        await f.manager.start(f.request);
        commands.resetObservations();
        await commands.run('malt.aws.showCoverage');
        await commands.run('malt.aws.showTraces');
        assert.deepEqual(commands.documents, [
          { kind: 'coverage', value: coverageValue() }, { kind: 'traces', value: tracesValue() },
        ]);
        assert.deepEqual(f.calls, ['focus', 'coverage', 'document:coverage', 'focus', 'traces', 'document:traces']);
      });
    },
  },
  {
    name: 'AWS commands: resource arguments are strict queue DTOs, including nested secret-bearing extras',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        const commands = new CommandFixture(f);
        const queue = queueValue();
        const invalid: readonly unknown[] = [
          undefined, null, 'file:///private', {}, { ...queue, id: 'wrong' },
          { ...queue, token: 'argument-secret' }, { ...queue, details: { ...queue.details, body: 'argument-secret' } },
          { ...queue, details: { ...queue.details, messageCounts: { ...queue.details.messageCounts, receipt: 'argument-secret' } } },
        ];
        for (const value of invalid) {
          await commands.run('malt.aws.openResource', value);
        }
        assert.equal(commands.documents.length, 0);
        assert.equal(commands.errors.length, invalid.length);
        assert.ok(commands.errors.every(message => !message.includes('argument-secret')));
        await commands.run('malt.aws.openResource', queue);
        assert.deepEqual(commands.documents, [{ kind: 'resource', value: queue }]);
      });
    },
  },
  {
    name: 'AWS commands: wrapper catches failures and reports clear messages without raw errors, bodies or arguments',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const commands = new CommandFixture(f);
        const secret = 'RAW-SECRET-BODY-credential-argument';
        f.host.onStart = async (options): Promise<never> => await Promise.reject(new Error(`${secret}:${options.token}`));
        await assert.doesNotReject(commands.run('malt.aws.start', secret));
        assert.equal(commands.errors.length, 1);
        const message = commands.errors[0];
        assert.ok(message !== undefined && message.length > 0);
        assert.ok(!message.includes(secret));
        assert.doesNotMatch(message, /\n\s+at /u);
        const options = f.host.starts[0];
        assert.ok(options !== undefined);
        assert.ok(!message.includes(options.token));
        assert.ok(!f.logs.join('\n').includes(options.token));
      });
    },
  },
];
