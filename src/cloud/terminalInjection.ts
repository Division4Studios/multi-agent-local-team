import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import { absentFile, ordinaryFile, realDirectory, sameFile } from '../shared/aws/files';
import { containedAbsoluteState } from './containment';
import { terminalEnvironment } from './terminal';

export interface AwsTerminalTarget {
  readonly workspaceRoot: string;
  readonly stateDirectory: string;
  readonly endpoint: string;
  readonly region: string;
}

const writeProfile = async (target: AwsTerminalTarget, current: () => boolean): Promise<string> => {
  const root = await containedAbsoluteState(target.workspaceRoot, target.stateDirectory);
  const directory = await realDirectory(root);
  const file = join(root, 'terminal-profile.ini');
  await ordinaryFile(file);
  const temporary = join(root, `.terminal-profile.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(`[profile malt-local]\nregion = ${target.region}\n[malt-local]\naws_access_key_id = test\naws_secret_access_key = test\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await containedAbsoluteState(target.workspaceRoot, target.stateDirectory);
    if (!sameFile(directory.identity, (await realDirectory(root)).identity)) { throw new Error('Profile directory changed.'); }
    await ordinaryFile(file);
    if (current()) { await rename(temporary, file); }
  } finally { await removeTemporary(temporary); }
  return file;
};
const removeTemporary = async (path: string): Promise<void> => {
  try { await unlink(path); }
  catch (error) { if (!absentFile(error)) { throw error; } }
};

/** Serialized disk commits plus generation-checked publication, including callback re-entry. */
export class AwsTerminalInjection {
  private readonly collection: Pick<vscode.EnvironmentVariableCollection, 'persistent' | 'replace' | 'clear'>;
  private generation = 0;
  private disposed = false;
  private pending: Promise<void> = Promise.resolve();
  public constructor(collection: Pick<vscode.EnvironmentVariableCollection, 'persistent' | 'replace' | 'clear'>) {
    this.collection = collection;
    collection.persistent = false;
    collection.clear();
  }
  public async update(target: AwsTerminalTarget | undefined): Promise<void> {
    if (this.disposed) { throw new Error('Local AWS terminal injection is disposed.'); }
    const generation = ++this.generation;
    this.collection.clear();
    if (target === undefined) { return; }
    const updating = this.pending.then(async () => { await this.apply(target, generation); });
    this.pending = updating.catch(() => undefined);
    await updating;
  }
  public dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.collection.clear();
  }
  private current(generation: number): boolean { return !this.disposed && this.generation === generation; }
  private async apply(target: AwsTerminalTarget, generation: number): Promise<void> {
    if (!this.current(generation)) { return; }
    try {
      const env = terminalEnvironment(target.endpoint, target.region);
      const file = await writeProfile(target, () => this.current(generation));
      const replacements = { ...env, AWS_PROFILE: 'malt-local', AWS_DEFAULT_PROFILE: 'malt-local',
        AWS_SESSION_TOKEN: '', AWS_SECURITY_TOKEN: '', AWS_CONFIG_FILE: file, AWS_SHARED_CREDENTIALS_FILE: file };
      if (this.current(generation)) { this.collection.clear(); }
      for (const [key, value] of Object.entries(replacements)) {
        if (!this.current(generation)) { return; }
        this.collection.replace(key, value);
      }
    } catch {
      if (this.current(generation)) { this.collection.clear(); }
      throw new Error('Local AWS terminal profile could not be written safely.');
    }
  }
}
