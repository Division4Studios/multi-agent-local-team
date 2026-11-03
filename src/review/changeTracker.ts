/**
 * Watches git working-tree changes (including edits made on disk by coding agents) and keeps the HunkStore
 * in sync. Reports newly appeared blocks so they can be reviewed and their file brought into view.
 */
import * as vscode from 'vscode';
import { GIT_STATUS } from '../git/gitApi';
import type { GitApi, GitChange, GitRepository } from '../git/gitApi';
import { hunkId, newFileHunks, parseUnifiedDiff } from '../diff/unifiedDiff';
import type { DiffHunk } from '../diff/unifiedDiff';
import type { HunkStore, TrackedHunk } from './hunkStore';

const DEBOUNCE_MS = 600;
const MAX_NEW_FILE_BYTES = 512_000;
const SKIPPED_STATUSES: ReadonlySet<number> = new Set([GIT_STATUS.deleted, GIT_STATUS.indexDeleted, GIT_STATUS.ignored]);
const NEW_FILE_STATUSES: ReadonlySet<number> = new Set([GIT_STATUS.untracked, GIT_STATUS.intentToAdd]);

export interface NewHunksEvent {
  readonly uri: vscode.Uri;
  readonly hunks: readonly TrackedHunk[];
  readonly initial: boolean;
}

interface CachedDiff {
  readonly version: string;
  readonly hunks: readonly DiffHunk[];
}

export class ChangeTracker implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly cache = new Map<string, CachedDiff>();
  private readonly newHunksEmitter = new vscode.EventEmitter<NewHunksEvent>();
  public readonly onDidFindNewHunks = this.newHunksEmitter.event;
  private timer: NodeJS.Timeout | undefined;
  private refreshing: Promise<void> = Promise.resolve();
  private initial = true;
  private readonly git: GitApi;
  private readonly folder: vscode.WorkspaceFolder;
  private readonly store: HunkStore;

  public constructor(git: GitApi, folder: vscode.WorkspaceFolder, store: HunkStore) {
    this.git = git;
    this.folder = folder;
    this.store = store;
    for (const repository of git.repositories) {
      this.watch(repository);
    }
    this.disposables.push(git.onDidOpenRepository((repository) => { this.watch(repository); }), this.newHunksEmitter);
    this.schedule();
  }

  public schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.refreshing = this.refreshing.then(async () => { await this.refresh(); }).catch(() => undefined);
    }, DEBOUNCE_MS);
  }

  public dispose(): void {
    clearTimeout(this.timer);
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private watch(repository: GitRepository): void {
    this.disposables.push(repository.state.onDidChange(() => { this.schedule(); }));
    this.schedule();
  }

  private async refresh(): Promise<void> {
    const seen = new Set<string>();
    for (const repository of this.git.repositories) {
      for (const change of this.relevantChanges(repository)) {
        const key = change.uri.toString();
        if (!seen.has(key)) {
          seen.add(key);
          await this.refreshFile(repository, change);
        }
      }
    }
    this.store.retainFiles(seen);
    this.initial = false;
  }

  private relevantChanges(repository: GitRepository): GitChange[] {
    const { workingTreeChanges, indexChanges, untrackedChanges = [] } = repository.state;
    return [...workingTreeChanges, ...indexChanges, ...untrackedChanges].filter(
      (change) => !SKIPPED_STATUSES.has(change.status) && this.relativePath(change.uri) !== undefined,
    );
  }

  private relativePath(uri: vscode.Uri): string | undefined {
    const relative = vscode.workspace.asRelativePath(uri, false);
    const inFolder = vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === this.folder.uri.toString();
    return inFolder && relative !== uri.fsPath ? relative.split('\\').join('/') : undefined;
  }

  private async refreshFile(repository: GitRepository, change: GitChange): Promise<void> {
    const relativePath = this.relativePath(change.uri);
    if (relativePath === undefined) {
      return;
    }
    const hunks = await this.computeHunks(repository, change);
    const tracked = hunks.map((hunk) => ({ id: hunkId(relativePath, hunk), uri: change.uri, relativePath, hunk }));
    const added = this.store.setFileHunks(change.uri, tracked);
    if (added.length > 0) {
      this.newHunksEmitter.fire({ uri: change.uri, hunks: added, initial: this.initial });
    }
  }

  private async computeHunks(repository: GitRepository, change: GitChange): Promise<readonly DiffHunk[]> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(change.uri);
    } catch {
      return [];
    }
    const key = change.uri.toString();
    const version = `${String(change.status)}:${String(stat.mtime)}:${String(stat.size)}`;
    const cached = this.cache.get(key);
    if (cached?.version === version) {
      return cached.hunks;
    }
    const hunks = NEW_FILE_STATUSES.has(change.status)
      ? await readNewFileHunks(change.uri, stat.size)
      : parseUnifiedDiff(await repository.diffWithHEAD(change.uri.fsPath));
    this.cache.set(key, { version, hunks });
    return hunks;
  }
}

const readNewFileHunks = async (uri: vscode.Uri, size: number): Promise<readonly DiffHunk[]> => {
  if (size > MAX_NEW_FILE_BYTES) {
    return [];
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return bytes.includes(0) ? [] : newFileHunks(Buffer.from(bytes).toString('utf8'));
};
