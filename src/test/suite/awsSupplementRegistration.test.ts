import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { registerAwsCommands } from '../../cloud/commands';
import type { AwsCommandDependencies, AwsCommandRegistrar } from '../../cloud/commands';
import type { AwsStartRequest } from '../../cloud/manager';
import type { TestCase } from './harness';
import { AWS_COMMANDS } from './awsCommandFixture';
import { coverageValue, queueValue, tracesValue } from './awsData';
import type { Coverage, QueueResource, Traces } from './awsData';
import { withAws } from './awsTestFixtures';
import type { AwsFixture } from './awsTestFixtures';

class Registrar {
  public readonly handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  public readonly disposed: string[] = [];
  public attempts = 0;
  public failAt: number | undefined;
  public readonly register: AwsCommandRegistrar = (id, handler): vscode.Disposable => {
    const index = this.attempts++;
    if (index === this.failAt) { throw new Error('synthetic registrar failure'); }
    assert.ok(!this.handlers.has(id), 'each native ID has one owner');
    this.handlers.set(id, handler);
    return { dispose: (): void => { this.disposed.push(id); } };
  };

  public async run(id: string, ...args: unknown[]): Promise<void> {
    const handler = this.handlers.get(id);
    assert.ok(handler !== undefined);
    await handler(...args);
  }
}

class RegistrationUi {
  public request: AwsStartRequest | undefined;
  public readonly documents: { readonly kind: string; readonly value: unknown }[] = [];
  public readonly terminals: vscode.TerminalOptions[] = [];
  public readonly errors: string[] = [];
  public readonly dependencies: AwsCommandDependencies;

  public constructor(fixture: AwsFixture) {
    this.request = fixture.request;
    this.dependencies = {
      manager: fixture.manager,
      startRequest: (): AwsStartRequest | undefined => this.request,
      confirmReset: async (): Promise<boolean> => await Promise.resolve(true),
      refresh: async (): Promise<void> => { fixture.calls.push('refresh'); await Promise.resolve(); },
      showDocument: async (kind: 'resource' | 'coverage' | 'traces', value: QueueResource | Coverage | Traces): Promise<void> => {
        this.documents.push({ kind, value }); await Promise.resolve();
      },
      createTerminal: (options: vscode.TerminalOptions): void => { this.terminals.push(options); },
      onUserFocus: (): void => { fixture.calls.push('focus'); },
      reportError: (message: string): void => { this.errors.push(message); },
    };
  }
}

export const tests: readonly TestCase[] = [
  {
    name: 'AWS supplement registrar: captures all nine real wrapped handlers and disposes exactly their returned registrations',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const ui = new RegistrationUi(f);
        const registrar = new Registrar();
        const registration = registerAwsCommands(ui.dependencies, registrar.register);
        try {
          assert.deepEqual(new Set(registrar.handlers.keys()), new Set(AWS_COMMANDS));
          assert.equal(registrar.attempts, 9);
          for (const request of [undefined, { ...f.request, trusted: false }]) {
            ui.request = request;
            for (const id of AWS_COMMANDS) { await registrar.run(id, queueValue()); }
          }
          assert.deepEqual(f.calls, Array.from({ length: 18 }, (): string => 'focus'));
          assert.equal(ui.errors.length, 18);
          assert.equal(ui.documents.length + ui.terminals.length, 0);
          assert.deepEqual(registrar.disposed, []);
        } finally {
          registration.dispose();
        }
        assert.equal(registrar.disposed.length, 9);
        assert.deepEqual(new Set(registrar.disposed), new Set(AWS_COMMANDS));
      });
    },
  },
  {
    name: 'AWS supplement registrar: captured callbacks dispatch each public command and preserve resource arguments',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const ui = new RegistrationUi(f);
        const registrar = new Registrar();
        const registration = registerAwsCommands(ui.dependencies, registrar.register);
        try {
          await registrar.run('malt.aws.start');
          await registrar.run('malt.aws.showCoverage');
          await registrar.run('malt.aws.showTraces');
          await registrar.run('malt.aws.openResource', queueValue());
          await registrar.run('malt.aws.reset');
          await registrar.run('malt.aws.refresh');
          await registrar.run('malt.aws.openTerminal');
          await registrar.run('malt.aws.restart');
          await registrar.run('malt.aws.stop');
          assert.equal(f.host.starts.length, 2);
          assert.equal(f.manager.status.state, 'stopped');
          assert.equal(f.calls.filter(call => call === 'focus').length, 9);
          assert.equal(f.calls.filter(call => call === 'refresh').length, 2);
          assert.ok(f.calls.includes('reset:"all"'));
          assert.deepEqual(ui.documents, [
            { kind: 'coverage', value: coverageValue() }, { kind: 'traces', value: tracesValue() }, { kind: 'resource', value: queueValue() },
          ]);
          assert.equal(ui.terminals.length, 1);
          assert.equal(ui.terminals[0]?.name, 'MALT Local AWS');
          assert.deepEqual(ui.errors, []);
        } finally {
          registration.dispose();
        }
      });
    },
  },
  {
    name: 'AWS supplement registrar: failure at early, middle or last registration cleans every prior owner before throwing',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const ui = new RegistrationUi(f);
        for (const index of [0, 1, 4, 8]) {
          const registrar = new Registrar();
          registrar.failAt = index;
          assert.throws(() => registerAwsCommands(ui.dependencies, registrar.register));
          assert.equal(registrar.attempts, index + 1);
          assert.equal(registrar.disposed.length, index);
          assert.deepEqual(new Set(registrar.disposed), new Set(registrar.handlers.keys()));
        }
        assert.deepEqual(f.calls, []);
        await Promise.resolve();
      });
    },
  },
];
