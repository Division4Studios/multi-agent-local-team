/**
 * Starts, monitors and stops the reviewer. Prefers Docker; falls back to the host daemon when Docker is
 * unavailable (or has no credentials) unless the user pinned a backend in settings.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { readSettings } from '../config';
import { PROTOCOL_VERSION } from '../shared/protocol';
import { ReviewerClient } from '../review/reviewerClient';
import type { ReviewerBackend } from './backend';
import type { Credentials } from './credentials';
import { DockerBackend } from './dockerBackend';
import { defaultDockerSocket } from './dockerApi';
import { HostBackend } from './hostBackend';

export type ReviewerState = 'stopped' | 'starting' | 'running' | 'unhealthy' | 'error';

export interface ReviewerStatus {
  readonly state: ReviewerState;
  readonly backend?: ReviewerBackend['kind'];
  readonly detail: string;
  readonly provider?: string;
  readonly rulesLoaded?: number;
  readonly modulesLoaded?: number;
  /** When the architecture map was generated; empty if there is none. */
  readonly architectureScannedAt?: string;
}

const HEALTH_INTERVAL_MS = 10_000;
const STARTUP_TIMEOUT_MS = 90_000;
const FAILURES_BEFORE_UNHEALTHY = 3;

const freePort = async (): Promise<number> =>
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolvePromise(port);
      });
    });
  });

const delay = async (ms: number): Promise<void> => { await new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  }); };

export class ReviewerManager implements vscode.Disposable {
  private readonly statusEmitter = new vscode.EventEmitter<ReviewerStatus>();
  public readonly onDidChangeStatus = this.statusEmitter.event;
  private currentStatus: ReviewerStatus = { state: 'stopped', detail: 'Not started' };
  private backend: ReviewerBackend | undefined;
  private activeClient: ReviewerClient | undefined;
  private monitor: NodeJS.Timeout | undefined;
  private failures = 0;
  private readonly extensionRoot: string;
  private readonly credentials: Credentials;
  private readonly output: vscode.LogOutputChannel;

  public constructor(extensionRoot: string, credentials: Credentials, output: vscode.LogOutputChannel) {
    this.extensionRoot = extensionRoot;
    this.credentials = credentials;
    this.output = output;
  }

  public get status(): ReviewerStatus {
    return this.currentStatus;
  }

  /** The client, only while the reviewer is healthy. */
  public get client(): ReviewerClient | undefined {
    return this.currentStatus.state === 'running' ? this.activeClient : undefined;
  }

  public async start(workspaceRoot: string): Promise<void> {
    await this.stop();
    this.setStatus({ state: 'starting', detail: 'Choosing backend…' });
    try {
      const backend = await this.chooseBackend();
      this.backend = backend;
      this.setStatus({ state: 'starting', backend: backend.kind, detail: `Starting ${backend.kind} reviewer…` });
      const endpoint = { port: await freePort(), token: randomBytes(32).toString('hex') };
      const settings = readSettings();
      const env = {
        MALT_TRIAGE_MODEL: settings.triageModel,
        MALT_REVIEW_MODEL: settings.reviewModel,
        MALT_STANDARDS_MODEL: settings.standardsModel,
        ...(await this.credentials.env()),
      };
      await backend.start({ workspaceRoot, port: endpoint.port, token: endpoint.token, env });
      this.activeClient = new ReviewerClient(endpoint);
      await this.waitForHealthy(this.activeClient);
      this.monitor = setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.error(`Reviewer failed to start: ${message}`);
      this.setStatus({ state: 'error', ...this.backendField(), detail: message });
      throw error;
    }
  }

  public async stop(): Promise<void> {
    clearInterval(this.monitor);
    this.monitor = undefined;
    this.activeClient = undefined;
    const backend = this.backend;
    this.backend = undefined;
    if (backend !== undefined) {
      await backend.stop();
    }
    this.setStatus({ state: 'stopped', detail: 'Stopped' });
  }

  public async logs(): Promise<string> {
    return this.backend === undefined ? '' : await this.backend.recentLogs();
  }

  public dispose(): void {
    void this.stop();
    this.statusEmitter.dispose();
  }

  private async chooseBackend(): Promise<ReviewerBackend> {
    const settings = readSettings();
    const log = (line: string): void => {
      this.output.info(line);
    };
    const docker = new DockerBackend(settings.dockerSocketPath === '' ? defaultDockerSocket() : settings.dockerSocketPath, this.extensionRoot, log);
    const host = new HostBackend(this.extensionRoot, settings.claudePath, log);
    if (settings.backend === 'host') {
      return host;
    }
    const dockerReady = await docker.isAvailable();
    const hasCredentials = await this.credentials.hasAny();
    if (dockerReady && hasCredentials) {
      return docker;
    }
    const reason = dockerReady ? 'no Claude credentials stored (run "MALT: Set Claude Credentials")' : 'Docker is not running';
    if (settings.backend === 'docker') {
      throw new Error(`Docker backend unavailable: ${reason}`);
    }
    this.output.warn(`Using host reviewer: ${reason}`);
    return host;
  }

  private async waitForHealthy(client: ReviewerClient): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let lastError = 'no response';
    while (Date.now() < deadline) {
      try {
        await this.applyHealth(client);
        return;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error.message : String(error);
        await delay(1_000);
      }
    }
    throw new Error(`Reviewer did not become healthy: ${lastError}`);
  }

  private async applyHealth(client: ReviewerClient): Promise<void> {
    const health = await client.health();
    if (health.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(`Reviewer protocol ${String(health.protocolVersion)} does not match ${String(PROTOCOL_VERSION)}`);
    }
    this.failures = 0;
    this.setStatus({
      state: 'running',
      ...this.backendField(),
      detail: 'Healthy',
      provider: health.provider,
      rulesLoaded: health.rulesLoaded,
      modulesLoaded: health.modulesLoaded,
      architectureScannedAt: health.architectureScannedAt,
    });
  }

  private async checkHealth(): Promise<void> {
    const client = this.activeClient;
    if (client === undefined) {
      return;
    }
    try {
      await this.applyHealth(client);
    } catch (error: unknown) {
      this.failures += 1;
      if (this.failures >= FAILURES_BEFORE_UNHEALTHY) {
        const running = (await this.backend?.isRunning()) ?? false;
        const detail = running ? `Not responding: ${error instanceof Error ? error.message : String(error)}` : 'Reviewer exited';
        this.setStatus({ state: running ? 'unhealthy' : 'error', ...this.backendField(), detail });
      }
    }
  }

  private backendField(): { backend?: ReviewerBackend['kind'] } {
    return this.backend === undefined ? {} : { backend: this.backend.kind };
  }

  private setStatus(status: ReviewerStatus): void {
    this.currentStatus = status;
    void vscode.commands.executeCommand('setContext', 'malt.reviewerState', status.state);
    this.statusEmitter.fire(status);
  }
}
