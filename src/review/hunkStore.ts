/** In-memory state of changed blocks per file and their review status, with results cached by block id. */
import * as vscode from 'vscode';
import type { DiffHunk } from '../diff/unifiedDiff';
import type { HunkReview } from '../shared/protocol';

export type HunkStatus = 'pending' | 'queued' | 'reviewing' | 'reviewed' | 'error';

export interface TrackedHunk {
  readonly id: string;
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly hunk: DiffHunk;
}

export interface HunkState {
  readonly status: HunkStatus;
  readonly review?: HunkReview;
  readonly error?: string;
}

const PENDING: HunkState = { status: 'pending' };
const MAX_CACHED_STATES = 2_000;
const PERSIST_KEY = 'malt.reviews.v1';

export class HunkStore implements vscode.Disposable {
  private readonly files = new Map<string, readonly TrackedHunk[]>();
  private readonly states = new Map<string, HunkState>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.changeEmitter.event;
  private readonly memento: vscode.Memento;

  public constructor(memento: vscode.Memento) {
    this.memento = memento;
    const persisted = memento.get<Record<string, HunkReview>>(PERSIST_KEY, {});
    for (const [id, review] of Object.entries(persisted)) {
      this.states.set(id, { status: 'reviewed', review });
    }
  }

  /** Replaces a file's blocks; returns the blocks that were not tracked for that file before. */
  public setFileHunks(uri: vscode.Uri, hunks: readonly TrackedHunk[]): TrackedHunk[] {
    const key = uri.toString();
    const previous = new Set((this.files.get(key) ?? []).map((hunk) => hunk.id));
    if (hunks.length === 0) {
      this.files.delete(key);
    } else {
      this.files.set(key, hunks);
    }
    this.changeEmitter.fire();
    return hunks.filter((hunk) => !previous.has(hunk.id));
  }

  public retainFiles(keep: ReadonlySet<string>): void {
    const removed = [...this.files.keys()].filter((key) => !keep.has(key));
    for (const key of removed) {
      this.files.delete(key);
    }
    if (removed.length > 0) {
      this.changeEmitter.fire();
    }
  }

  public hunksFor(uri: vscode.Uri): readonly TrackedHunk[] {
    return this.files.get(uri.toString()) ?? [];
  }

  public allFiles(): readonly (readonly TrackedHunk[])[] {
    return [...this.files.values()];
  }

  public allHunks(): readonly TrackedHunk[] {
    return [...this.files.values()].flat();
  }

  public find(uri: vscode.Uri, line: number): TrackedHunk | undefined {
    return this.hunksFor(uri).find((tracked) => line >= tracked.hunk.startLine && line <= tracked.hunk.endLine);
  }

  public get(id: string): TrackedHunk | undefined {
    return this.allHunks().find((tracked) => tracked.id === id);
  }

  public state(id: string): HunkState {
    return this.states.get(id) ?? PENDING;
  }

  public setState(id: string, state: HunkState): void {
    this.states.delete(id);
    this.states.set(id, state);
    if (this.states.size > MAX_CACHED_STATES) {
      const oldest = this.states.keys().next();
      if (oldest.done !== true) {
        this.states.delete(oldest.value);
      }
    }
    this.changeEmitter.fire();
    if (state.status === 'reviewed') {
      void this.persist();
    }
  }

  public dispose(): void {
    this.changeEmitter.dispose();
  }

  private async persist(): Promise<void> {
    const reviews: Record<string, HunkReview> = {};
    for (const [id, state] of this.states) {
      if (state.review !== undefined) {
        reviews[id] = state.review;
      }
    }
    await this.memento.update(PERSIST_KEY, reviews);
  }
}
