import assert from 'node:assert/strict';
import type { AwsBackend, AwsBackendStart, AwsEndpoint } from '../../cloud/backend';
import { TEST_ENDPOINT } from './awsData';

/** A resource exists only after startup completes; an earlier stop cannot remove it. */
export class FakeBackend implements AwsBackend {
  public readonly kind: 'host' | 'docker';
  public readonly starts: AwsBackendStart[] = [];
  public readonly live = new Set<number>();
  public readonly removed: number[] = [];
  public readonly cleanupTargets: number[][] = [];
  public stops = 0;
  public available = true;
  public onStart: (options: AwsBackendStart) => Promise<AwsEndpoint> = async (): Promise<AwsEndpoint> => await Promise.resolve(TEST_ENDPOINT);
  public onStop: (() => Promise<void>) | undefined;
  private readonly calls: string[];

  public constructor(kind: 'host' | 'docker', calls: string[]) {
    this.kind = kind;
    this.calls = calls;
  }

  public async isAvailable(): Promise<boolean> {
    this.calls.push(`${this.kind}:available`);
    return await Promise.resolve(this.available);
  }

  public async start(options: AwsBackendStart): Promise<AwsEndpoint> {
    this.starts.push(options);
    const id = this.starts.length;
    this.calls.push(`${this.kind}:start`);
    const endpoint = await this.onStart(options);
    this.live.add(id);
    return endpoint;
  }

  public async stop(): Promise<void> {
    this.stops += 1;
    this.calls.push(`${this.kind}:stop`);
    const targets = [...this.live];
    this.cleanupTargets.push(targets);
    if (targets.length > 0) { await this.onStop?.(); }
    for (const id of targets) { this.live.delete(id); this.removed.push(id); }
  }
}

export const assertRemoved = (backend: FakeBackend, id: number): void => {
  assert.ok(backend.removed.includes(id), 'cleanup must complete for this resource');
  assert.ok(!backend.live.has(id), 'the late resource must not remain live');
};
