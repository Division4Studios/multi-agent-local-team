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
