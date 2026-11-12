import * as vscode from 'vscode';
import { parseAwsQueueResource } from '../shared/aws/parsers';
import type { AwsCoverage, AwsQueueResource, AwsTraces } from '../shared/aws/types';
import type { AwsAdminApi } from './adminClient';
import type { AwsManager, AwsStartRequest } from './manager';
import { terminalEnvironment } from './terminal';

export interface AwsCommandDependencies {
  readonly manager: {
    readonly status: AwsManager['status'];
    readonly client: AwsAdminApi | undefined;
    start(request: AwsStartRequest): Promise<void>;
    stop(): Promise<void>;
  };
  readonly startRequest: () => AwsStartRequest | undefined;
  readonly confirmReset: () => Promise<boolean>;
  readonly refresh: () => Promise<void>;
  showDocument(kind: 'resource', value: AwsQueueResource): Promise<void>;
  showDocument(kind: 'coverage', value: AwsCoverage): Promise<void>;
  showDocument(kind: 'traces', value: AwsTraces): Promise<void>;
  readonly createTerminal: (options: vscode.TerminalOptions) => void;
  /** Native wiring waits for current collection/profile publication before process creation. */
  readonly prepareTerminal?: () => Promise<void>;
  readonly onUserFocus: () => void;
  readonly reportError: (message: string) => void;
}
type Handler = (...args: unknown[]) => Promise<void>;
export type AwsCommandRegistrar = (id: string, handler: Handler) => vscode.Disposable;

const trustedRequest = (deps: AwsCommandDependencies): AwsStartRequest | undefined => {
  const request = deps.startRequest();
  if (request?.trusted !== true) {
    deps.reportError('Local AWS requires an open, trusted workspace.');
    return undefined;
  }
  return request;
};
const requireClient = (deps: AwsCommandDependencies): AwsAdminApi => {
  const client = deps.manager.client;
  if (client === undefined) { throw new Error('Local AWS is not running.'); }
  return client;
};
const reset = async (deps: AwsCommandDependencies): Promise<void> => {
  if (!await deps.confirmReset()) { return; }
  await requireClient(deps).reset('all');
  await deps.refresh();
};
const openTerminal = async (deps: AwsCommandDependencies, request: AwsStartRequest): Promise<void> => {
  if (deps.manager.status.state !== 'running') { await deps.manager.start(request); }
  await deps.prepareTerminal?.();
  if (trustedRequest(deps) === undefined) { return; }
  const status = deps.manager.status;
  if (status.state !== 'running' || status.endpoint === undefined || status.region === undefined) {
    throw new Error('Local AWS is not ready for a terminal.');
  }
  deps.createTerminal({ name: 'MALT Local AWS', env: terminalEnvironment(status.endpoint.gatewayUrl, status.region) });
};
const openResource = async (deps: AwsCommandDependencies, value: unknown): Promise<void> => {
  const resource = parseAwsQueueResource(value);
  if (resource === undefined) { throw new Error('Invalid Local AWS resource.'); }
  await deps.showDocument('resource', resource);
};

export const createAwsCommandHandlers = (deps: AwsCommandDependencies): ReadonlyMap<string, Handler> => {
  const actions: ReadonlyMap<string, (request: AwsStartRequest, args: readonly unknown[]) => Promise<void>> = new Map([
    ['start', async (request: AwsStartRequest): Promise<void> => { await deps.manager.start(request); }],
    ['stop', async (): Promise<void> => { await deps.manager.stop(); }],
    ['restart', async (): Promise<void> => {
      await deps.manager.stop();
      const request = trustedRequest(deps);
      if (request !== undefined) { await deps.manager.start(request); }
    }],
    ['reset', async (): Promise<void> => { await reset(deps); }],
    ['refresh', async (): Promise<void> => { await deps.refresh(); }],
    ['showCoverage', async (): Promise<void> => { await deps.showDocument('coverage', await requireClient(deps).coverage()); }],
    ['showTraces', async (): Promise<void> => { await deps.showDocument('traces', await requireClient(deps).traces()); }],
    ['openResource', async (...[, args]: [AwsStartRequest, readonly unknown[]]): Promise<void> => { await openResource(deps, args[0]); }],
    ['openTerminal', async (request: AwsStartRequest): Promise<void> => { await openTerminal(deps, request); }],
  ]);
  return new Map([...actions].map(([name, action]) => [`malt.aws.${name}`, async (...args: unknown[]): Promise<void> => {
    try {
      deps.onUserFocus();
      const request = trustedRequest(deps);
      if (request !== undefined) { await action(request, args); }
    } catch { deps.reportError(`Local AWS ${name} failed. Check workspace settings and the Local AWS status.`); }
  }]));
};

export const registerAwsCommands = (deps: AwsCommandDependencies, registerCommand: AwsCommandRegistrar = vscode.commands.registerCommand): vscode.Disposable => {
  const owned: vscode.Disposable[] = [];
  try {
    for (const [id, handler] of createAwsCommandHandlers(deps)) { owned.push(registerCommand(id, handler)); }
  } catch (error) { for (const registration of owned) { registration.dispose(); } throw error; }
  return vscode.Disposable.from(...owned);
};
