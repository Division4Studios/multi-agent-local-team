/**
 * One pull request under review: its blocks in their own store and queue (so PR results never mix with the user's
 * local changes), a consolidation check across the PR, and the same outlines and hover cards as local changes.
 * Nothing is persisted: closing the review drops its results.
 */
import * as vscode from 'vscode';
import { HunkStore } from '../review/hunkStore';
import type { ReviewCacheStorage, TrackedHunk } from '../review/hunkStore';
import { ReviewQueue } from '../review/reviewQueue';
import type { HunkReviewer } from '../review/reviewQueue';
import { ConsolidationCheck } from '../review/consolidation';
import type { ConsolidationClient } from '../review/consolidation';
import { HunkDecorations } from '../editor/decorations';
import { ReviewHoverProvider } from '../editor/reviewMarkdown';
import { ChangesTreeProvider } from '../views/changesView';
import type { PullRequestSummary } from '../github/githubApi';
import type { PreviousHead } from './pullRequestCheckout';
import type { SkippedFile } from './pullRequestBlocks';

/** PR reviews live only as long as the review: an in-memory cache, never written to workspace state. */
class MemoryCache implements ReviewCacheStorage {
  private readonly values = new Map<string, unknown>();

  public get(key: string): unknown {
    return this.values.get(key);
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    await Promise.resolve();
  }
}

export interface PullRequestReviewOptions {
  readonly pull: PullRequestSummary;
  readonly previous: PreviousHead;
  readonly blocks: readonly TrackedHunk[];
  readonly skipped: readonly SkippedFile[];
  readonly client: () => (HunkReviewer & ConsolidationClient) | undefined;
  readonly concurrency: () => number;
}

export class PullRequestReview implements vscode.Disposable {
  public readonly pull: PullRequestSummary;
  public readonly previous: PreviousHead;
  public readonly skipped: readonly SkippedFile[];
  public readonly store: HunkStore;
  public readonly queue: ReviewQueue;
  public readonly consolidation: ConsolidationCheck;
  public readonly tree: ChangesTreeProvider;
  private readonly disposables: vscode.Disposable[];
  private staleReason: string | undefined;

  public constructor(options: PullRequestReviewOptions) {
    this.pull = options.pull;
    this.previous = options.previous;
    this.skipped = options.skipped;
    this.store = new HunkStore(new MemoryCache());
    this.queue = new ReviewQueue({ store: this.store, client: options.client, concurrency: options.concurrency });
    this.consolidation = new ConsolidationCheck(this.store, options.client);
    this.tree = new ChangesTreeProvider(this.store, this.consolidation, 'pullRequest');
    const byFile = new Map<string, TrackedHunk[]>();
    for (const block of options.blocks) {
      byFile.set(block.uri.toString(), [...(byFile.get(block.uri.toString()) ?? []), block]);
    }
    for (const blocks of byFile.values()) {
      const [first] = blocks;
      if (first !== undefined) {
        this.store.setFileHunks(first.uri, blocks);
      }
    }
    this.disposables = [
      new HunkDecorations(this.store),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, new ReviewHoverProvider(this.store)),
    ];
  }

  public get blockCount(): number {
    return this.store.allHunks().length;
  }

  public get fileCount(): number {
    return this.store.allFiles().filter((blocks) => blocks.length > 0).length;
  }

  /** Blocks whose review finished (passed or failed). */
  public get reviewedCount(): number {
    return this.store.allHunks().filter((tracked) => this.store.state(tracked.id).status === 'reviewed').length;
  }

  /** Why the review stopped because the workspace no longer holds the PR's files; undefined while it does. */
  public get stale(): string | undefined {
    return this.staleReason;
  }

  /**
   * The workspace no longer holds the PR's files: stops for good, so no call reads, and no result describes, files
   * that are not the PR's. Results finished before stay. Returns whether this call changed anything.
   */
  public invalidate(reason: string): boolean {
    if (this.staleReason !== undefined) {
      return false;
    }
    this.staleReason = reason;
    void this.stop();
    return true;
  }

  /** Queues every block that has no finished review, then checks consolidation across the whole PR. */
  public reviewAll(): void {
    for (const tracked of this.store.allHunks()) {
      this.queue.enqueue(tracked);
    }
    void this.consolidation.run();
  }

  /** A block of this review, by id (and line, when the same content appears more than once). */
  public find(id: string, startLine?: number): TrackedHunk | undefined {
    return this.store.get(id, startLine);
  }

  /**
   * Stops all review work for good and resolves once calls already in flight have finished. In-flight calls read
   * files from the workspace, so this must settle before the workspace leaves the PR checkout.
   */
  public async stop(): Promise<void> {
    await Promise.all([this.queue.stop(), this.consolidation.stop()]);
  }

  public dispose(): void {
    void this.stop();
    vscode.Disposable.from(...this.disposables, this.tree, this.consolidation, this.store).dispose();
  }
}
