import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { AwsAdminApi } from './adminClient';
import type { AwsBackend, AwsBackendStart, AwsEndpoint } from './backend';
import { containedState } from './containment';
import { allocateAdminPort, chooseBackend, validateStart } from './startOptions';
import { validRegion } from '../shared/aws/validation';
import type { AwsTerminalTarget } from './terminalInjection';

export interface AwsStatus {
  readonly state: 'stopped' | 'starting' | 'running' | 'stopping' | 'unhealthy' | 'error';
  readonly requestCount: number;
  readonly detail: string;
  readonly backend?: 'host' | 'docker';
  readonly endpoint?: AwsEndpoint;
  readonly region?: string;
}
export interface AwsStartRequest {
  readonly workspaceRoot: string;
  readonly trusted: boolean;
  readonly backend: 'auto' | 'host' | 'docker';
  readonly bindAddress: string;
  readonly port: number;
  readonly stateDirectory: string;
  readonly region: string;
}
export interface AwsManagerDependencies {
  readonly docker: AwsBackend;
  readonly host: AwsBackend;
  readonly hasSocketConsent: () => boolean;
  readonly requestSocketConsent: () => Promise<boolean>;
  readonly storeSocketConsent: () => Promise<void>;
  readonly confirmHostFallback: () => Promise<boolean>;
  readonly confirmExternalBind: (address: string) => Promise<boolean>;
  readonly client: (endpoint: { readonly url: string; readonly token: string }) => AwsAdminApi;
  readonly log: (message: string) => void;
}
interface Instance { readonly backend: AwsBackend; readonly workspaceRoot: string; readonly stateDirectory: string; api?: AwsAdminApi }

/** Lifecycle work is serialized; cancellation invalidates publications synchronously. */
export class AwsManager implements vscode.Disposable {
  private readonly deps: AwsManagerDependencies;
  private readonly changed = new vscode.EventEmitter<AwsStatus>();
  public readonly onDidChangeStatus = this.changed.event;
  private value: AwsStatus = { state: 'stopped', requestCount: 0, detail: 'Local AWS is stopped.' };
  private generation = 0;
  private disposed = false;
  private pending: Promise<void> = Promise.resolve();
  private active: Instance | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private healthSequence = 0;
  public constructor(deps: AwsManagerDependencies) { this.deps = deps; }
  public get status(): AwsStatus { return this.value; }
  public get client(): AwsAdminApi | undefined { return this.value.state === 'running' ? this.active?.api : undefined; }
  public get terminalTarget(): AwsTerminalTarget | undefined {
    const status = this.value;
    const instance = this.active;
    return status.state === 'running' && status.endpoint !== undefined && status.region !== undefined && instance !== undefined
      ? { workspaceRoot: instance.workspaceRoot, stateDirectory: instance.stateDirectory, endpoint: status.endpoint.gatewayUrl, region: status.region }
      : undefined;
  }
  public configureRegion(region: string): void {
    if (!validRegion(region)) { throw new Error('Invalid Local AWS signing region.'); }
    if (this.active !== undefined && this.value.region !== region) { this.publish({ ...this.value, region }); }
  }

  public async start(request: AwsStartRequest): Promise<void> {
    if (this.disposed) { throw new Error('Local AWS is disposed.'); }
    validateStart(request);
    if (this.value.state === 'running') { return; }
    const generation = ++this.generation;
    await this.enqueue(async () => { await this.begin(request, generation); });
  }
  public async stop(): Promise<void> {
    this.generation += 1;
    this.clearTimer();
    this.publish({ state: 'stopping', requestCount: this.value.requestCount, detail: 'Stopping Local AWS.' });
    await this.enqueue(async () => {
      try {
        await this.cleanup();
        this.publish({ state: 'stopped', requestCount: 0, detail: 'Local AWS is stopped.' });
      } catch {
        this.fail('Local AWS shutdown or cleanup failed; saved state is not confirmed.');
        throw new Error('Local AWS shutdown or cleanup failed.');
      }
    });
  }
  public dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    void this.stop().catch(() => { this.deps.log('Local AWS disposal could not complete owned backend cleanup.'); });
    this.changed.dispose();
  }
  public async checkHealth(): Promise<void> {
    const instance = this.active;
    const api = instance?.api;
    if (api === undefined || !['running', 'unhealthy'].includes(this.value.state)) { return; }
    const generation = this.generation;
    const sequence = ++this.healthSequence;
    const current = (): boolean => this.current(generation) && this.active === instance && sequence === this.healthSequence;
    try {
      const health = await api.health();
      if (current()) { this.publish({ ...this.value, state: 'running', requestCount: health.requestCount, detail: 'Local AWS is running.' }); }
    } catch {
      if (current()) { this.publish({ ...this.value, state: 'unhealthy', detail: 'Local AWS health check failed.' }); }
    }
  }
  private async enqueue(action: () => Promise<void>): Promise<void> {
    const work = this.pending.then(action);
    this.pending = work.catch(() => undefined);
    await work;
  }
  private current(generation: number): boolean { return !this.disposed && generation === this.generation; }
  private check(generation: number): void {
    if (!this.current(generation)) { throw new Error('Local AWS start was cancelled.'); }
  }
  private async begin(request: AwsStartRequest, generation: number): Promise<void> {
    this.check(generation);
    try {
      if (this.active !== undefined) { await this.cleanup(); }
      const stateDirectory = await containedState(request.workspaceRoot, request.stateDirectory, true);
      this.check(generation);
      this.publish({ state: 'starting', requestCount: 0, detail: 'Starting Local AWS.' });
      this.check(generation);
      const backend = await chooseBackend(this.deps, request, () => { this.check(generation); });
      const adminPort = await allocateAdminPort(request.port);
      this.check(generation);
      const options: AwsBackendStart = { workspaceRoot: request.workspaceRoot, stateDirectory,
        bindAddress: request.bindAddress, port: request.port, adminPort, token: randomBytes(32).toString('hex') };
      const instance: Instance = { backend, workspaceRoot: request.workspaceRoot, stateDirectory };
      this.active = instance;
      const endpoint = await backend.start(options);
      instance.api = this.deps.client({ url: endpoint.adminUrl, token: options.token });
      this.check(generation);
      const health = await instance.api.health();
      this.check(generation);
      this.publish({ state: 'running', requestCount: health.requestCount, detail: 'Local AWS is running.',
        backend: backend.kind, endpoint, region: request.region });
      if (this.current(generation)) { this.timer = setInterval(() => { void this.checkHealth(); }, 10_000); }
    } catch {
      await this.failedStart(generation);
    }
  }
  private async failedStart(generation: number): Promise<never> {
    let message = 'Local AWS could not start. Check settings, state permissions and backend availability.';
    try { await this.cleanup(); }
    catch { message = 'Local AWS startup failed and owned backend cleanup is incomplete.'; }
    if (this.current(generation)) { this.fail(message); }
    throw new Error(this.current(generation) ? message : 'Local AWS start was cancelled.');
  }
  private async cleanup(): Promise<void> {
    this.clearTimer();
    const instance = this.active;
    if (instance === undefined) { return; }
    let shutdownFailed = false;
    try { await instance.api?.shutdown(); }
    catch { shutdownFailed = true; }
    // Preserve the owner on cleanup failure so a subsequent stop can reconcile it.
    await instance.backend.stop();
    this.active = undefined;
    if (shutdownFailed) { throw new Error('Local AWS graceful shutdown failed.'); }
  }
  private clearTimer(): void { clearInterval(this.timer); this.timer = undefined; }
  private fail(detail: string): void {
    this.deps.log(detail);
    this.publish({ state: 'error', requestCount: 0, detail });
  }
  private publish(status: AwsStatus): void { this.value = status; if (!this.disposed) { this.changed.fire(status); } }
}
