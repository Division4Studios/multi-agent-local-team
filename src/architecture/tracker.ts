import * as vscode from 'vscode';
import type { GitApi, GitRepository } from '../git/gitApi';
import type { FileFacts } from './extract';
import type { Snapshot } from './graph';
import { allowedPaths, bounded, eligible, headOf, readFacts, relativePath, snapshotOf, SOURCE_GLOB, workingFiles, workingReader } from './sources';
import { reviewerMap, withUnderstanding } from './knowledge';
import { saveMapFile, saveSnapshot } from './storage';

/** One serial writer per folder. A checkout invalidates even an in-flight scan of the old branch. */
export class MapTracker implements vscode.Disposable {
  public readonly folder: vscode.WorkspaceFolder;
  public repository: GitRepository | undefined;
  public snapshot: Snapshot | undefined;
  public message = 'Indexing the workspace…';
  private readonly change = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.change.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly dirty = new Set<string>();
  private facts = new Map<string, FileFacts | undefined>();
  private full = true;
  private total = 0;
  private generation = 0;
  private busy = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private branchKey = '';
  private repositoryListener: vscode.Disposable | undefined;

  public constructor(folder: vscode.WorkspaceFolder, git: GitApi | undefined) {
    this.folder = folder;
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, SOURCE_GLOB));
    const ignores = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/.gitignore'));
    const ignoreChanged = (uri: vscode.Uri): void => {
      if (!relativePath(folder.uri, uri).split('/').includes('.malt')) {
        this.refresh();
      }
    };
    const notes = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.malt/maps/v1/{note-,scan-}*.json'));
    const reload = (): void => { this.schedule(); };
    this.subscriptions.push(notes, notes.onDidChange(reload), notes.onDidCreate(reload), notes.onDidDelete(reload), watcher, ignores, ignores.onDidChange(ignoreChanged), ignores.onDidCreate(ignoreChanged), ignores.onDidDelete(ignoreChanged),
      watcher.onDidChange((uri) => { this.fileChanged(uri, false); }), watcher.onDidCreate((uri) => { this.fileChanged(uri, true); }),
      watcher.onDidDelete((uri) => { this.fileChanged(uri, true); }));
    if (git !== undefined) {
      for (const repo of git.repositories) {
        this.attach(repo);
      }
      this.subscriptions.push(git.onDidOpenRepository((repo) => { this.attach(repo); }));
    }
    this.refresh();
  }
  private attach(repo: GitRepository): void {
    const path = relativePath(repo.rootUri, this.folder.uri);
    if (path.startsWith('..') || path.includes(':') || this.repository === repo) {
      return;
    }
    if (this.repository !== undefined && this.repository.rootUri.fsPath.length >= repo.rootUri.fsPath.length) {
      return;
    }
    this.repositoryListener?.dispose();
    this.repository = repo;
    const checkHead = (): void => {
      const key = JSON.stringify(headOf(repo));
      if (this.branchKey !== key) {
        this.branchKey = key;
        this.snapshot = undefined;
        this.message = 'Indexing the checked-out branch…';
        this.change.fire();
        this.refresh();
      }
    };
    this.repositoryListener = repo.state.onDidChange(checkHead);
    checkHead();
  }
  private fileChanged(uri: vscode.Uri, inventoryChanged: boolean): void {
    const path = relativePath(this.folder.uri, uri);
    if (eligible(path)) {
      this.dirty.add(path);
      this.full ||= inventoryChanged;
      this.schedule();
    }
  }
  public refresh(): void {
    this.full = true;
    this.schedule();
  }
  private schedule(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.run(); }, 400);
  }
  private async run(): Promise<void> {
    if (this.busy || this.disposed) {
      return;
    }
    this.busy = true;
    const generation = this.generation;
    const head = headOf(this.repository);
    const current = (): boolean => !this.disposed && generation === this.generation && JSON.stringify(head) === JSON.stringify(headOf(this.repository));
    try {
      await this.update(head, current);
    } catch (error: unknown) {
      if (current()) {
        this.message = `Architecture indexing failed: ${String(error)}`;
        this.change.fire();
      }
    } finally {
      this.busy = false;
      if (this.generation !== generation) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { void this.run(); }, 400);
      }
    }
  }
  private async update(head: ReturnType<typeof headOf>, current: () => boolean): Promise<void> {
    const paths = this.full ? await workingFiles(this.folder) : [...this.dirty];
    const allowed = await allowedPaths(this.folder.uri, this.repository, paths);
    const selected = this.full ? bounded(allowed) : allowed.filter((path) => this.facts.has(path));
    const changes = await readFacts(selected, workingReader(this.folder), current);
    if (!current()) {
      return;
    }
    const next = this.full ? changes : new Map([...this.facts, ...changes]);
    const total = this.full ? allowed.length : this.total;
    const snapshot = await withUnderstanding(this.folder.uri.fsPath, snapshotOf(next, head, total));
    await saveSnapshot(this.folder.uri.fsPath, 'branch', snapshot, current);
    await saveMapFile(this.folder.uri.fsPath, 'reviewer.json', reviewerMap(snapshot), current);
    if (current()) {
      this.total = total;
      this.facts = next;
      this.snapshot = snapshot;
      this.full = false;
      this.dirty.clear();
      this.message = '';
      this.change.fire();
    }
  }
  public dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.repositoryListener?.dispose();
    vscode.Disposable.from(this.change, ...this.subscriptions).dispose();
  }
}
