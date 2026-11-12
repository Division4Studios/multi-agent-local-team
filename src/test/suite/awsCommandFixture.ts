import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { createAwsCommandHandlers } from '../../cloud/commands';
import type { AwsCommandDependencies } from '../../cloud/commands';
import type { AwsStartRequest } from '../../cloud/manager';
import type { AwsFixture, Coverage, QueueResource, Traces } from './awsTestFixtures';

export const AWS_COMMANDS = [
  'malt.aws.start', 'malt.aws.stop', 'malt.aws.restart', 'malt.aws.reset', 'malt.aws.refresh',
  'malt.aws.showCoverage', 'malt.aws.showTraces', 'malt.aws.openResource', 'malt.aws.openTerminal',
];

export class CommandFixture {
  public current: AwsStartRequest | undefined;
  public readonly errors: string[] = [];
  public readonly terminals: vscode.TerminalOptions[] = [];
  public readonly documents: { readonly kind: string; readonly value: unknown }[] = [];
  public readonly handlers: ReturnType<typeof createAwsCommandHandlers>;
  public allowReset = false;
  public reads = 0;
  private readonly fixture: AwsFixture;

  public constructor(fixture: AwsFixture) {
    this.fixture = fixture;
    this.current = fixture.request;
    const deps: AwsCommandDependencies = {
      manager: fixture.manager,
      startRequest: (): AwsStartRequest | undefined => {
        this.reads += 1;
        return this.current;
      },
      confirmReset: async (): Promise<boolean> => {
        fixture.calls.push('confirm-reset');
        return await Promise.resolve(this.allowReset);
      },
      refresh: async (): Promise<void> => {
        fixture.calls.push('refresh');
        await Promise.resolve();
      },
      showDocument: async (kind: 'resource' | 'coverage' | 'traces', value: QueueResource | Coverage | Traces): Promise<void> => {
        fixture.calls.push(`document:${kind}`);
        this.documents.push({ kind, value });
        await Promise.resolve();
      },
      createTerminal: (options: vscode.TerminalOptions): void => {
        fixture.calls.push('terminal');
        this.terminals.push(options);
      },
      onUserFocus: (): void => { fixture.calls.push('focus'); },
      reportError: (message: string): void => { this.errors.push(message); },
    };
    this.handlers = createAwsCommandHandlers(deps);
  }

  public async run(id: string, ...args: unknown[]): Promise<void> {
    const handler = this.handlers.get(id);
    assert.ok(handler !== undefined, `handler missing: ${id}`);
    await handler(...args);
  }

  public resetObservations(): void {
    this.errors.length = 0;
    this.fixture.calls.length = 0;
    this.reads = 0;
  }
}
