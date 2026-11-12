/** Shared public-boundary oracles, executable by controls without any cloud implementation. */
import assert from 'node:assert/strict';
import { lstat, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import type * as vscode from 'vscode';
import type { AwsSocketConsent } from '../../cloud/socketConsent';
import { drain, fulfilled, observe, rejected } from './awsAsyncFixture';
import { deferred, waitFor } from './testUtils';

export const CONSENT_KEY = 'malt.aws.dockerSocketConsent';

export class ConsentState implements Pick<vscode.Memento, 'get' | 'update'> {
  public readonly values = new Map<string, unknown>();
  public readonly reads: string[] = [];
  public readonly writes: { readonly key: string; readonly value: unknown }[] = [];
  public beforeWrite: (() => Promise<void>) | undefined;

  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined;
  public get(key: string, defaultValue?: unknown): unknown {
    this.reads.push(key);
    return this.values.has(key) ? this.values.get(key) : defaultValue;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.writes.push({ key, value });
    await this.beforeWrite?.();
    this.values.set(key, value);
  }
}

type Consent = Pick<AwsSocketConsent, 'grant' | 'has'>;

export const assertGrantPersists = async (consent: Consent, state: ConsentState): Promise<void> => {
  const gate = deferred<undefined>();
  state.beforeWrite = async (): Promise<void> => { await gate.promise; };
  // Deferring the call also turns a synchronous boundary throw into an observed rejection.
  const granting = observe(Promise.resolve().then(async (): Promise<void> => { await consent.grant(); }));
  try {
    await waitFor(() => state.writes.length === 1 || granting.settled, 'grant entered the public Memento update');
    assert.deepEqual(state.writes, [{ key: CONSENT_KEY, value: { version: 1, granted: true } }]);
    assert.equal(granting.settled, false, 'grant must wait for the gated persistence');
    assert.equal(consent.has(), false);
    gate.resolve(undefined);
    await fulfilled(granting);
    assert.equal(consent.has(), true);
  } finally {
    gate.resolve(undefined);
    await drain([granting]);
  }
};

export const assertGrantFailure = async (consent: Consent, state: ConsentState): Promise<void> => {
  state.beforeWrite = async (): Promise<void> => { await Promise.reject(new Error('synthetic persistence failure')); };
  const granting = observe(Promise.resolve().then(async (): Promise<void> => { await consent.grant(); }));
  try {
    await rejected(granting);
    assert.deepEqual(state.writes, [{ key: CONSENT_KEY, value: { version: 1, granted: true } }]);
    assert.equal(state.values.has(CONSENT_KEY), false);
    assert.equal(consent.has(), false);
  } finally {
    await drain([granting]);
  }
};

export class InjectionCollection implements Pick<vscode.EnvironmentVariableCollection, 'persistent' | 'replace' | 'clear'> {
  public persistent = true;
  public readonly values = new Map<string, string>([['PREVIOUS_MUTATION', 'stale']]);
  public readonly replacements: { readonly name: string; readonly value: string }[] = [];
  public clears = 0;
  public onReplace: (() => void) | undefined;

  public replace(name: string, value: string): void {
    this.values.set(name, value);
    this.replacements.push({ name, value });
    this.onReplace?.();
  }

  public clear(): void {
    this.clears += 1;
    this.values.clear();
  }
}

export const assertNoStalePublication = (collection: InjectionCollection, atInvalidation: number | undefined): void => {
  assert.ok(atInvalidation !== undefined, 'the invalidation callback must actually be reached');
  assert.equal(collection.values.size, 0);
  assert.equal(collection.replacements.length, atInvalidation, 'no replacement may occur after clear/dispose returns');
};

interface LinkIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}

export interface FileSymlinkSnapshot {
  readonly path: string;
  readonly target: string;
  readonly linkText: string;
  readonly bytes: Buffer;
  readonly identity: LinkIdentity;
}

export const createFileSymlink = async (path: string, target: string, bytes: Buffer): Promise<FileSymlinkSnapshot> => {
  await writeFile(target, bytes, { flag: 'wx' });
  await symlink(target, path, 'file');
  const before = await lstat(path, { bigint: true });
  assert.ok(before.isSymbolicLink(), 'this must be a true file symlink, never a directory junction');
  assert.ok((await lstat(target)).isFile(), 'the link target itself is a regular file');
  assert.ok((await stat(path)).isFile(), 'a defective stat().isFile() check would follow this destination');
  return {
    path, target, linkText: await readlink(path), bytes: Buffer.from(bytes),
    identity: { dev: before.dev, ino: before.ino, birthtimeNs: before.birthtimeNs },
  };
};

export const assertFileSymlinkRetained = async (before: FileSymlinkSnapshot): Promise<void> => {
  const after = await lstat(before.path, { bigint: true });
  assert.ok(after.isSymbolicLink(), 'refusal must not replace the link');
  assert.deepEqual({ dev: after.dev, ino: after.ino, birthtimeNs: after.birthtimeNs }, before.identity, 'link identity is retained');
  assert.equal(await readlink(before.path), before.linkText, 'the link target is retained');
  assert.deepEqual(await readFile(before.target), before.bytes, 'the regular target retains every original byte');
};

export interface ResidentSnapshot<T> {
  readonly uri: T;
  readonly displayed: string;
}

export const snapshotResidents = <T>(uris: readonly T[], read: (uri: T) => string): ResidentSnapshot<T>[] =>
  uris.map(uri => ({ uri, displayed: read(uri) }));

export const assertResidentBytes = <T>(snapshot: readonly ResidentSnapshot<T>[], read: (uri: T) => string): void => {
  for (const entry of snapshot) { assert.equal(read(entry.uri), entry.displayed, 'invalid add must preserve resident displayed bytes'); }
};

export const assertOldestEvicted = <T>(snapshot: readonly ResidentSnapshot<T>[], read: (uri: T) => string): void => {
  const oldest = snapshot[0];
  assert.ok(oldest !== undefined);
  assert.throws(() => read(oldest.uri), 'the original oldest entry must still be first to evict');
  assertResidentBytes(snapshot.slice(1), read);
};
