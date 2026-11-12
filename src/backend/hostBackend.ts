/**
 * Fallback when Docker is unavailable: runs the reviewer service as a Node process on the host,
 * using VS Code's own runtime (ELECTRON_RUN_AS_NODE), bound to 127.0.0.1.
 * Unlike the Docker backend, the model CLI it calls runs with the user's permissions.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { LogSink, ReviewerBackend, StartOptions } from './backend';
import { createLineSplitter } from '../shared/lineSplitter';
import { AwsAdminClient } from '../cloud/adminClient';
import type { AwsBackend, AwsBackendOptions, AwsBackendStart, AwsEndpoint } from '../cloud/backend';
import { backendEndpoint, validateBackendStart } from '../cloud/startOptions';
import { pause, runtimeReady } from '../cloud/runtimeReady';

const STOP_GRACE_MS = 3_000;

const MAX_LOG_LINES = 200;

export class HostBackend implements ReviewerBackend {
  public readonly kind = 'host';
  private child: ChildProcess | undefined;
  private readonly logLines: string[] = [];
  private readonly extensionRoot: string;
  private readonly claudePath: string;
  private readonly log: LogSink;

  public constructor(extensionRoot: string, claudePath: string, log: LogSink) {
    this.extensionRoot = extensionRoot;
    this.claudePath = claudePath;
    this.log = log;
  }

  public async isAvailable(): Promise<boolean> {
    return await Promise.resolve(true);
  }

  public async start(options: StartOptions): Promise<void> {
    await this.stop();
    const child = spawn(process.execPath, [join(this.extensionRoot, 'out', 'reviewer', 'main.js')], {
      env: {
        ...process.env,
        ...options.env,
        ELECTRON_RUN_AS_NODE: '1',
        MALT_PORT: String(options.port),
        MALT_HOST: '127.0.0.1',
        MALT_WORKSPACE: options.workspaceRoot,
        MALT_TOKEN: options.token,
        MALT_CLAUDE_PATH: this.claudePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // One splitter per stream: lines (and multi-byte characters) can span chunks, and the streams interleave.
    const onLine = (line: string): void => {
      if (line !== '') {
        this.remember(line);
        this.log(line);
      }
    };
    const stdout = createLineSplitter(onLine);
    const stderr = createLineSplitter(onLine);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('exit', (code) => {
      stdout.end();
      stderr.end();
      this.log(`Reviewer process exited with code ${String(code)}`);
      if (this.child === child) {
        this.child = undefined;
      }
    });
    this.child = child;
    this.log(`Started host reviewer (pid ${String(child.pid)})`);
  }

  /**
   * Asks the reviewer to shut down (it closes its server and any open live-log streams), and force-kills it if it
   * has not exited within STOP_GRACE_MS, so a stuck process can never keep serving after a stop or restart.
   */
  public async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child?.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolvePromise) => {
      child.once('exit', () => {
        resolvePromise();
      });
    });
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        this.log('Reviewer did not stop in time; forcing it to exit');
        child.kill('SIGKILL');
      }
    }, STOP_GRACE_MS);
    await exited;
    clearTimeout(timer);
  }

  /** A host reviewer has no container limits to raise. */
  public async resize(): Promise<void> {
    await Promise.resolve();
  }

  public async isRunning(): Promise<boolean> {
    return await Promise.resolve(this.child?.exitCode === null);
  }

  public async recentLogs(): Promise<string> {
    return await Promise.resolve(this.logLines.join('\n'));
  }

  private remember(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > MAX_LOG_LINES) {
      this.logLines.shift();
    }
  }
}

/** The emulator has a fixed entry point and never inherits cloud credentials or Node injection flags. */
const awsEnvironment = (options: AwsBackendStart): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    const value = process.env[key];
    if (value !== undefined) { env[key] = value; }
  }
  return { ...env, ELECTRON_RUN_AS_NODE: '1', MALT_AWS_HOST: options.bindAddress,
    MALT_AWS_PORT: String(options.port), MALT_AWS_ADMIN_HOST: '127.0.0.1', MALT_AWS_ADMIN_PORT: String(options.adminPort),
    MALT_AWS_ADMIN_TOKEN: options.token, MALT_AWS_STATE_DIRECTORY: options.stateDirectory,
    MALT_AWS_ENDPOINT: backendEndpoint(options).gatewayUrl };
};
const hasExited = (child: ChildProcess): boolean => child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
const awaitExit = async (child: ChildProcess, milliseconds: number): Promise<boolean> => {
  if (hasExited(child)) { return true; }
  const deadline = Date.now() + milliseconds;
  while (!hasExited(child) && Date.now() < deadline) { await pause(25); }
  return hasExited(child);
};

export class AwsHostBackend implements AwsBackend {
  public readonly kind = 'host';
  private readonly options: AwsBackendOptions;
  private child: ChildProcess | undefined;
  private admin: AwsAdminClient | undefined;
  private starting = false;
  public constructor(options: AwsBackendOptions) { this.options = options; }
  public async isAvailable(): Promise<boolean> { return await Promise.resolve(true); }
  public async start(options: AwsBackendStart): Promise<AwsEndpoint> {
    if (this.starting || this.child !== undefined) { throw new Error('Local AWS host already owns a process.'); }
    this.starting = true;
    try {
      await validateBackendStart(options);
      const endpoint = backendEndpoint(options);
      const admin = new AwsAdminClient({ url: endpoint.adminUrl, token: options.token });
      const child = spawn(process.execPath, [join(this.options.extensionRoot, 'out', 'aws', 'main.js')], {
        env: awsEnvironment(options), cwd: this.options.extensionRoot, stdio: 'ignore', windowsHide: true,
      });
      this.child = child;
      this.admin = admin;
      let failed = false;
      child.on('error', () => { failed = true; });
      await runtimeReady(admin, () => failed || hasExited(child));
      this.options.log('Local AWS host is ready.');
      return endpoint;
    } catch {
      await this.stop();
      throw new Error('Local AWS host startup failed.');
    } finally { this.starting = false; }
  }
  public async stop(): Promise<void> {
    const child = this.child;
    if (child === undefined) { return; }
    // A manager may have just acknowledged shutdown; give that save/exit a chance first.
    let graceful = await awaitExit(child, 100);
    if (!graceful) {
      try { await this.admin?.shutdown(); }
      catch { this.options.log('Local AWS host shutdown was not acknowledged.'); }
      graceful = await awaitExit(child, STOP_GRACE_MS);
    }
    if (!graceful) { await this.terminate(child); }
    this.child = undefined;
    this.admin = undefined;
    if (!graceful) { throw new Error('Local AWS host needed forced termination; saved state is not confirmed.'); }
    this.options.log('Local AWS host stopped.');
  }
  private async terminate(child: ChildProcess): Promise<void> {
    child.kill('SIGTERM');
    if (await awaitExit(child, STOP_GRACE_MS)) { return; }
    child.kill('SIGKILL');
    if (!await awaitExit(child, STOP_GRACE_MS)) { throw new Error('Local AWS host process cleanup failed.'); }
  }
}
