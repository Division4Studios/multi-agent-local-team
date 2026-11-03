/**
 * Sends changed blocks to the reviewer with bounded concurrency; one isolated review per block.
 *
 * The queue is the source of truth for what is waiting and in flight (`waitingIds` / `inFlightIds`); the store's
 * status is only a display of it. "Busy" is never inferred from a displayed status, so a block whose status went
 * stale (e.g. it vanished while waiting) can always be queued again.
 */
import type { HunkReview, ReviewRequest } from '../shared/protocol';
import type { HunkStore, TrackedHunk } from './hunkStore';

/** The one capability the queue needs from the reviewer. */
export interface HunkReviewer {
  review: (request: ReviewRequest) => Promise<HunkReview>;
}

export interface QueueOptions {
  readonly store: HunkStore;
  readonly client: () => HunkReviewer | undefined;
  readonly concurrency: () => number;
}

export class ReviewQueue {
  private readonly waiting: TrackedHunk[] = [];
  private readonly waitingIds = new Set<string>();
  private readonly inFlightIds = new Set<string>();
  private readonly options: QueueOptions;

  public constructor(options: QueueOptions) {
    this.options = options;
  }

  /** Queues a block unless it is already waiting or in flight. Reviewed blocks are skipped unless `force`. */
  public enqueue(tracked: TrackedHunk, force = false): void {
    const busy = this.waitingIds.has(tracked.id) || this.inFlightIds.has(tracked.id);
    if (busy || (!force && this.options.store.state(tracked.id).status === 'reviewed')) {
      return;
    }
    if (this.options.client() === undefined) {
      this.options.store.setState(tracked.id, { status: 'pending' });
      return;
    }
    this.waitingIds.add(tracked.id);
    this.waiting.push(tracked);
    this.options.store.setState(tracked.id, { status: 'queued' });
    this.pump();
  }

  /** Queues every tracked block that has no review yet (e.g. once the reviewer comes online). */
  public enqueueUnreviewed(): void {
    for (const tracked of this.options.store.allHunks()) {
      const { status } = this.options.store.state(tracked.id);
      if (status === 'pending' || status === 'error') {
        this.enqueue(tracked);
      }
    }
  }

  private pump(): void {
    while (this.inFlightIds.size < this.options.concurrency()) {
      const next = this.waiting.shift();
      if (next === undefined) {
        return;
      }
      this.waitingIds.delete(next.id);
      if (this.options.store.get(next.id) === undefined) {
        // The block vanished while waiting. Leave it reviewable if the same change comes back.
        this.options.store.setState(next.id, { status: 'pending' });
        continue;
      }
      this.inFlightIds.add(next.id);
      void this.run(next).finally(() => {
        this.inFlightIds.delete(next.id);
        this.pump();
      });
    }
  }

  private async run(tracked: TrackedHunk): Promise<void> {
    const client = this.options.client();
    if (client === undefined) {
      this.options.store.setState(tracked.id, { status: 'pending' });
      return;
    }
    this.options.store.setState(tracked.id, { status: 'reviewing' });
    try {
      const review = await client.review({
        filePath: tracked.relativePath,
        startLine: tracked.hunk.startLine,
        endLine: tracked.hunk.endLine,
        patch: `${tracked.hunk.header}\n${tracked.hunk.body}`,
      });
      this.options.store.setState(tracked.id, { status: 'reviewed', review });
    } catch (error: unknown) {
      this.options.store.setState(tracked.id, { status: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }
}
