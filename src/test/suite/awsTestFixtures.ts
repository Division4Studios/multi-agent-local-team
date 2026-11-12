/** Synthetic extension-boundary data from specs/aws/runtime.md; no service implementation imports. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwsManager } from '../../cloud/manager';
import type { AwsStartRequest } from '../../cloud/manager';
import { bounded } from './awsHttpFixture';
import { coverageValue, healthValue, queueValue, startRequest, tracesValue } from './awsData';
import { FakeBackend } from './awsBackendFixture';
import { fulfilled, observe } from './awsAsyncFixture';
import type { AdminApi, Coverage, Health, Resources, Traces } from './awsData';
export { TEST_ENDPOINT, coverageValue, healthValue, queueValue, startRequest, tracesValue } from './awsData';
export type { AdminApi, Coverage, Health, Resources, Traces, QueueResource } from './awsData';

const retainFailure = async (failures: unknown[], run: () => void | Promise<void>): Promise<void> => {
  try { await run(); } catch (error: unknown) { failures.push(error); }
};

const throwFailures = (failures: readonly unknown[]): void => {
  const distinct = [...new Set(failures)];
  if (distinct.length === 1) { throw distinct[0]; }
  if (distinct.length > 1) { throw new AggregateError(distinct, 'AWS fixture operation and cleanup failures'); }
};

export class FakeAdmin implements AdminApi {
  public readonly calls: string[];
  public healthCalls = 0;
  public resourcesValue: Resources = { resources: [queueValue()] };
  public onHealth: () => Promise<Health> = async (): Promise<Health> => await Promise.resolve(healthValue());
  public onResources: (() => Promise<Resources>) | undefined;
  public onShutdown: (() => Promise<void>) | undefined;
  public onReset: (() => Promise<void>) | undefined;

  public constructor(calls: string[] = []) {
    this.calls = calls;
  }

  public async health(): Promise<Health> {
    this.healthCalls += 1;
    this.calls.push('health');
    return await this.onHealth();
  }

  public async resources(): Promise<Resources> {
    this.calls.push('resources');
    return this.onResources === undefined ? await Promise.resolve(this.resourcesValue) : await this.onResources();
  }

  public async coverage(): Promise<Coverage> {
    this.calls.push('coverage');
    return await Promise.resolve(coverageValue());
  }

  public async traces(): Promise<Traces> {
    this.calls.push('traces');
    return await Promise.resolve(tracesValue());
  }

  public async save(): Promise<void> {
    this.calls.push('save');
    await Promise.resolve();
  }

  public async reset(scope: Parameters<AdminApi['reset']>[0]): Promise<void> {
    this.calls.push(`reset:${JSON.stringify(scope)}`);
    await this.onReset?.();
  }

  public async shutdown(): Promise<void> {
    this.calls.push('shutdown');
    await this.onShutdown?.();
  }
}

export class AwsFixture {
  public readonly root: string;
  public readonly calls: string[] = [];
  public readonly logs: string[] = [];
  public readonly clientInputs: { readonly url: string; readonly token: string }[] = [];
  public readonly host = new FakeBackend('host', this.calls);
  public readonly docker = new FakeBackend('docker', this.calls);
  public api = new FakeAdmin(this.calls);
  public readonly manager: AwsManager;
  public socketConsent = false;
  public allowSocket = true;
  public onSocketConsent: (() => Promise<boolean>) | undefined;
  public allowFallback = true;
  public allowBind = true;
  private disposed = false;

  public constructor(root: string) {
    this.root = root;
    this.manager = new AwsManager({
      host: this.host, docker: this.docker,
      hasSocketConsent: (): boolean => this.socketConsent,
      requestSocketConsent: async (): Promise<boolean> => {
        this.calls.push('consent');
        return this.onSocketConsent === undefined ? this.allowSocket : await this.onSocketConsent();
      },
      storeSocketConsent: async (): Promise<void> => {
        this.calls.push('store-consent');
        this.socketConsent = true;
        await Promise.resolve();
      },
      confirmHostFallback: async (): Promise<boolean> => await this.answer('fallback', this.allowFallback),
      confirmExternalBind: async (address: string): Promise<boolean> => await this.answer(`bind:${address}`, this.allowBind),
      client: (options): AdminApi => {
        this.clientInputs.push(options);
        return this.api;
      },
      log: (message: string): void => { this.logs.push(message); },
    });
  }

  public get request(): AwsStartRequest {
    return startRequest(this.root);
  }

  public async close(): Promise<void> {
    if (this.disposed) {
      await rm(this.root, { recursive: true, force: true });
      return;
    }
    const failures: unknown[] = [];
    const stopping = observe(Promise.resolve().then(async () => { await this.manager.stop(); }));
    try {
      await retainFailure(failures, async () => { await fulfilled(stopping); });
    } finally {
      try {
        await retainFailure(failures, () => { this.dispose(); });
      } finally {
        try {
          // A bounded second wait drains stop and retains a rejection arriving after the first deadline.
          await retainFailure(failures, async () => { await fulfilled(stopping); });
        } finally {
          await retainFailure(failures, async () => { await rm(this.root, { recursive: true, force: true }); });
        }
      }
    }
    throwFailures(failures);
  }

  public dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.manager.dispose();
    }
  }

  private async answer(call: string, value: boolean): Promise<boolean> {
    this.calls.push(call);
    return await Promise.resolve(value);
  }
}

export const withAws = async (run: (fixture: AwsFixture) => Promise<void>): Promise<void> => {
  const fixture = new AwsFixture(await mkdtemp(join(tmpdir(), 'malt-aws-extension-')));
  const failures: unknown[] = [];
  // Invoke inside the immediately observed promise so a synchronous callback throw also tears down.
  const running = Promise.resolve().then(async () => { await run(fixture); });
  try {
    await retainFailure(failures, async () => { await bounded(running, 30_000); });
  } finally {
    try {
      await retainFailure(failures, async () => { await bounded(running); });
    } finally {
      await retainFailure(failures, async () => { await fixture.close(); });
    }
  }
  throwFailures(failures);
};
