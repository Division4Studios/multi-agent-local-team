/**
 * In-memory state of changed blocks per file and their review status, with results cached by block id.
 * Partial reviews (overview done, some rule checks missing) are kept too, so a restart only runs what is missing.
 */
import * as vscode from 'vscode';
import type { DiffHunk } from '../diff/unifiedDiff';
import { parseHunkReview } from '../shared/protocol';
import type { HunkReview } from '../shared/protocol';
import { isRecord } from '../shared/guards';
import { missingRules } from './reviewProgress';

/** The subset of `vscode.Memento` the store needs (workspaceState satisfies it). */
export interface ReviewCacheStorage {
  get: (key: string) => unknown;
  update: (key: string, value: unknown) => Thenable<void>;
}

export type HunkStatus = 'pending' | 'queued' | 'reviewing' | 'reviewed' | 'error';

export interface TrackedHunk {
  readonly id: string;
  readonly uri: vscode.Uri;
  readonly relativePath: string;
  readonly hunk: DiffHunk;
}

export interface HunkState {
  readonly status: HunkStatus;
  /** Present from the overview on; rule checks are added as they finish. */
  readonly review?: HunkReview;
  /** Ids of the rules being checked right now (display only; the queue decides what is busy). */
  readonly running?: readonly string[];
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
  private readonly memento: ReviewCacheStorage;

  public constructor(memento: ReviewCacheStorage) {
    this.memento = memento;
    const persisted = memento.get(PERSIST_KEY);
    if (!isRecord(persisted)) {
      return;
    }
    // Persisted state is untrusted input: only entries that pass protocol validation are restored.
    for (const [id, value] of Object.entries(persisted)) {
      const review = parseHunkReview(value);
      if (review !== undefined) {
        this.states.set(id, { status: missingRules(review).length === 0 ? 'reviewed' : 'pending', review });
      }
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

  /** Resolve a specific occurrence when navigating; id-only callers retain shared review-cache semantics. */
  public get(id: string, startLine?: number): TrackedHunk | undefined {
    return this.allHunks().find((tracked) => tracked.id === id && (startLine === undefined || tracked.hunk.startLine === startLine));
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
    if (state.review !== undefined) {
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
