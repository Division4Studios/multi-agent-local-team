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
import { realPathInside } from '../shared/realPath';

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
      for (const change of await this.relevantChanges(repository)) {
        const key = change.uri.toString();
        if (!seen.has(key)) {
          seen.add(key);
          await this.refreshFile(repository, change);
        }
      }
    }
    this.store.retainFiles(seen);
    for (const key of this.cache.keys()) {
      if (!seen.has(key)) {
        this.cache.delete(key);
      }
    }
    this.initial = false;
  }

  private async relevantChanges(repository: GitRepository): Promise<GitChange[]> {
    const { workingTreeChanges, indexChanges, untrackedChanges = [] } = repository.state;
    const candidates = [...workingTreeChanges, ...indexChanges, ...untrackedChanges].filter((change) => {
      const path = this.relativePath(change.uri);
      return !SKIPPED_STATUSES.has(change.status) && path !== undefined && !path.split('/').includes('.malt');
    });
    if (candidates.length === 0) {
      return [];
    }
    // Ask Git so nested ignore files, negation, global excludes and .git/info/exclude all agree with SCM.
    // Do not review candidates when ignore resolution fails; retry on the next repository change.
    try {
      const ignored = await repository.checkIgnore([...new Set(candidates.map((change) => change.uri.fsPath))]);
      return candidates.filter((change) => !ignored.has(change.uri.fsPath));
    } catch {
      return [];
    }
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

  /** A regular file (not a symlink) whose real location is inside this workspace folder. */
  private async isReviewableFile(uri: vscode.Uri, stat: vscode.FileStat): Promise<boolean> {
    const isLink = (stat.type & vscode.FileType.SymbolicLink) !== 0;
    const isFile = (stat.type & vscode.FileType.File) !== 0;
    return !isLink && isFile && (await realPathInside(this.folder.uri.fsPath, uri.fsPath)) !== undefined;
  }

  private async computeHunks(repository: GitRepository, change: GitChange): Promise<readonly DiffHunk[]> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(change.uri);
    } catch {
      return [];
    }
    // Never follow a link out of the workspace: a symlink's target is not part of the change, and reading it
    // (to outline, open or send to the reviewer) could expose any file on the machine. Git tracks the link
    // itself, so there is nothing of the change to review here.
    if (!(await this.isReviewableFile(change.uri, stat))) {
      return [];
    }
    const key = change.uri.toString();
    // The diff depends on both sides: the file on disk (status/mtime/size) and the HEAD baseline. A commit,
    // checkout, reset or rebase changes HEAD without touching the file, so it must invalidate the cache too.
    const baseline = repository.state.HEAD?.commit ?? 'no-head';
    const version = `${baseline}:${String(change.status)}:${String(stat.mtime)}:${String(stat.size)}`;
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
