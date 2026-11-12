/** Native registration boundary: no startup side effects until an explicit trusted command. */
import * as vscode from 'vscode';
import { AwsHostBackend } from '../backend/hostBackend';
import { defaultDockerSocket } from '../backend/dockerApi';
import { readSettings } from '../config';
import { AwsAdminClient } from './adminClient';
import type { AwsBackend, AwsBackendOptions } from './backend';
import { registerAwsCommands } from './commands';
import { AwsDockerBackend } from './dockerBackend';
import { AwsDocuments } from './documents';
import { AwsManager } from './manager';
import { AwsResourcesProvider } from './resourcesView';
import { awsInjectionEnabled, awsStartRequest } from './settings';
import { AwsSocketConsent } from './socketConsent';
import { awsStatusBar } from './statusBar';
import { AwsTerminalInjection } from './terminalInjection';
import type { AwsTerminalTarget } from './terminalInjection';

const confirm = async (message: string, action: string): Promise<boolean> =>
  await vscode.window.showWarningMessage(message, { modal: true }, action) === action;

const configuredDocker = (options: AwsBackendOptions): AwsBackend => {
  let current: AwsDockerBackend | undefined;
  const get = (): AwsDockerBackend => {
    const socket = readSettings().dockerSocketPath;
    current ??= new AwsDockerBackend({ ...options, socketPath: socket === '' ? defaultDockerSocket() : socket });
    return current;
  };
  return {
    kind: 'docker', isAvailable: async (): Promise<boolean> => { current = undefined; return await get().isAvailable(); },
    start: async optionsToStart => await get().start(optionsToStart),
    stop: async (): Promise<void> => { await current?.stop(); current = undefined; },
  };
};

export const registerAwsFeature = (context: vscode.ExtensionContext, onUserFocus: () => void): vscode.Disposable => {
  const output = vscode.window.createOutputChannel('MALT Local AWS', { log: true });
  const log = (message: string): void => { output.info(message); };
  const options = { extensionRoot: context.extensionUri.fsPath, log };
  const consent = new AwsSocketConsent(context.globalState);
  const manager = new AwsManager({
    docker: configuredDocker(options), host: new AwsHostBackend(options), log,
    hasSocketConsent: (): boolean => consent.has(), storeSocketConsent: async (): Promise<void> => { await consent.grant(); },
    requestSocketConsent: async (): Promise<boolean> => await confirm('Local AWS mounts your Docker socket read-write. This grants control of local containers and can provide host-level access. Allow this on this machine?', 'Allow Docker Socket'),
    confirmHostFallback: async (): Promise<boolean> => await confirm('Docker is unavailable or its socket access was declined. Run Local AWS directly on this host with your user permissions?', 'Use Host'),
    confirmExternalBind: async (address): Promise<boolean> => await confirm(`Local AWS will listen on ${address}, exposing dummy-credential AWS APIs beyond loopback. Allow this binding for this start?`, 'Allow This Start'),
    client: (endpoint): AwsAdminClient => new AwsAdminClient(endpoint),
  });
  const documents = new AwsDocuments();
  const view = new AwsResourcesProvider(manager);
  const injection = new AwsTerminalInjection(context.environmentVariableCollection);
  const synchronize = injectionSync(injection, () => awsInjectionEnabled() ? manager.terminalTarget : undefined);
  let registrations: vscode.Disposable;
  try { registrations = nativeRegistrations({ manager, documents, view, synchronize, onUserFocus }); }
  catch (error) { vscode.Disposable.from(injection, view, documents, manager, output).dispose(); throw error; }
  const settings = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('malt.aws')) {
      try {
        const request = awsStartRequest();
        if (request !== undefined) { manager.configureRegion(request.region); }
        void synchronize().catch(() => { log('Local AWS terminal injection failed; mutations cleared.'); });
      } catch { void synchronize(true).catch(() => undefined); log('Invalid Local AWS settings; terminal injection cleared.'); }
    }
  });
  const status = manager.onDidChangeStatus(() => {
    void synchronize().catch(() => { log('Local AWS terminal injection failed; mutations cleared.'); });
    void view.refresh();
  });
  return vscode.Disposable.from(registrations, settings, status, injection, view, documents, manager, output);
};

interface NativeDependencies {
  readonly manager: AwsManager;
  readonly documents: AwsDocuments;
  readonly view: AwsResourcesProvider;
  readonly synchronize: () => Promise<void>;
  readonly onUserFocus: () => void;
}
const nativeRegistrations = ({ manager, documents, view, synchronize, onUserFocus }: NativeDependencies): vscode.Disposable => {
  const commands = registerAwsCommands({
    manager: {
      get status() { return manager.status; }, get client() { return manager.client; },
      start: async request => {
        await manager.start(request);
        const current = awsStartRequest();
        if (current !== undefined) { manager.configureRegion(current.region); }
        await synchronize();
      },
      stop: async () => { await manager.stop(); },
    },
    startRequest: awsStartRequest, onUserFocus,
    confirmReset: async () => await confirm('Reset all Local AWS resources and messages in this workspace? This cannot be undone.', 'Reset Local AWS'),
    refresh: async () => { await manager.checkHealth(); await view.refresh(); },
    prepareTerminal: synchronize,
    showDocument: async (kind, value) => { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(documents.add(kind, value)), { preview: true }); },
    createTerminal: options => { vscode.window.createTerminal(options).show(); },
    reportError: message => { void vscode.window.showErrorMessage(message); },
  });
  const owned: vscode.Disposable[] = [commands];
  try {
    owned.push(vscode.window.registerTreeDataProvider('malt.aws', view));
    owned.push(vscode.workspace.registerTextDocumentContentProvider('malt-aws', documents));
    owned.push(awsStatusBar(manager));
    return vscode.Disposable.from(...owned);
  } catch (error) { vscode.Disposable.from(...owned).dispose(); throw error; }
};

/** Count-only health events reuse the current write instead of clearing a live collection. */
const injectionSync = (injection: AwsTerminalInjection, target: () => AwsTerminalTarget | undefined): ((clear?: boolean) => Promise<void>) => {
  let key: string | undefined;
  let pending: Promise<void> = Promise.resolve();
  return async (clear = false): Promise<void> => {
    const value = clear ? undefined : target();
    const next = JSON.stringify(value);
    if (key !== next || value === undefined) {
      key = next;
      pending = injection.update(value);
    }
    let observed: Promise<void>;
    do {
      observed = pending;
      try { await observed; }
      catch (error) { if (pending === observed) { key = undefined; } throw error; }
    } while (observed !== pending);
  };
};
