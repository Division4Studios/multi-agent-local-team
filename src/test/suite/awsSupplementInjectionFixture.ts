import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwsTerminalInjection } from '../../cloud/terminalInjection';
import type { AwsTerminalTarget } from '../../cloud/terminalInjection';
import { bounded } from './awsHttpFixture';
import { InjectionCollection } from './awsSupplementOracles';

export class InjectionFixture {
  public readonly base: string;
  public readonly workspace: string;
  public readonly outside: string;
  public readonly state: string;
  public readonly profile: string;
  public readonly collection = new InjectionCollection();
  public readonly adapter = new AwsTerminalInjection(this.collection);
  public readonly pending: Promise<unknown>[] = [];
  private disposed = false;

  public constructor(base: string) {
    this.base = base;
    this.workspace = join(base, 'workspace');
    this.outside = join(base, 'outside');
    this.state = join(this.workspace, '.malt', 'aws');
    this.profile = join(this.state, 'terminal-profile.ini');
  }

  public get target(): AwsTerminalTarget {
    return { workspaceRoot: this.workspace, stateDirectory: this.state, endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' };
  }

  public async update(target: AwsTerminalTarget | undefined): Promise<void> {
    const updating = this.adapter.update(target);
    this.pending.push(Promise.allSettled([updating]));
    await updating;
  }

  public dispose(): void {
    if (!this.disposed) {
      this.disposed = true;
      this.adapter.dispose();
    }
  }
}

export const withInjection = async (run: (fixture: InjectionFixture) => Promise<void>): Promise<void> => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'malt-aws-injection-')));
  const fixture = new InjectionFixture(base);
  let running: Promise<void> | undefined;
  try {
    await mkdir(fixture.state, { recursive: true });
    await mkdir(fixture.outside);
    running = run(fixture);
    await bounded(running, 20_000);
  } finally {
    fixture.dispose();
    if (running !== undefined) { await bounded(Promise.allSettled([running])); }
    await bounded(Promise.all(fixture.pending));
    await rm(base, { recursive: true, force: true });
  }
};

export const expectedReplacements = (target: AwsTerminalTarget): Map<string, string> => new Map(Object.entries({
  AWS_ENDPOINT_URL: target.endpoint, AWS_ENDPOINT_URL_STS: target.endpoint,
  AWS_ENDPOINT_URL_SQS: target.endpoint, AWS_ENDPOINT_URL_S3: target.endpoint,
  AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
  AWS_REGION: target.region, AWS_DEFAULT_REGION: target.region,
  AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '',
  AWS_SESSION_TOKEN: '', AWS_SECURITY_TOKEN: '', AWS_PROFILE: 'malt-local', AWS_DEFAULT_PROFILE: 'malt-local',
  AWS_CONFIG_FILE: join(target.stateDirectory, 'terminal-profile.ini'),
  AWS_SHARED_CREDENTIALS_FILE: join(target.stateDirectory, 'terminal-profile.ini'),
}));

/** Match the exact sections/keys/values, without inventing INI whitespace or newline formatting. */
export const assertProfile = (text: string, region: string): void => {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    if (line === '') { continue; }
    const section = /^\[([^\]]+)\]$/u.exec(line)?.[1];
    if (section !== undefined) {
      assert.ok(!sections.has(section), 'no repeated sections');
      current = new Map<string, string>();
      sections.set(section, current);
      continue;
    }
    const assignment = /^([a-z_]+)\s*=\s*(.*?)\s*$/u.exec(line);
    assert.ok(assignment !== null && current !== undefined, 'only fixed profile assignments are allowed');
    const key = assignment[1];
    const value = assignment[2];
    assert.ok(key !== undefined && value !== undefined);
    assert.ok(!current.has(key), 'no repeated keys');
    current.set(key, value);
  }
  assert.deepEqual(sections, new Map([
    ['profile malt-local', new Map([['region', region]])],
    ['malt-local', new Map([['aws_access_key_id', 'test'], ['aws_secret_access_key', 'test']])],
  ]));
};

export const assertTarget = async (fixture: InjectionFixture, target: AwsTerminalTarget): Promise<void> => {
  assert.equal(fixture.collection.persistent, false);
  assert.deepEqual(fixture.collection.values, expectedReplacements(target));
  assertProfile(await readFile(join(target.stateDirectory, 'terminal-profile.ini'), 'utf8'), target.region);
};
