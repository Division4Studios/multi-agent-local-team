/** Sends changed blocks to the reviewer with bounded concurrency; one isolated review per block. */
import type { ReviewerClient } from './reviewerClient';
import type { HunkStore, TrackedHunk } from './hunkStore';

export interface QueueOptions {
  readonly store: HunkStore;
  readonly client: () => ReviewerClient | undefined;
  readonly concurrency: () => number;
}

export class ReviewQueue {
  private readonly waiting: TrackedHunk[] = [];
  private active = 0;
  private readonly options: QueueOptions;

  public constructor(options: QueueOptions) {
    this.options = options;
  }

  /** Queues a block unless it already has (or is getting) a review. `force` re-reviews it. */
  public enqueue(tracked: TrackedHunk, force = false): void {
    const { status } = this.options.store.state(tracked.id);
    const busy = status === 'queued' || status === 'reviewing';
    if (busy || (!force && status === 'reviewed')) {
      return;
    }
    if (this.options.client() === undefined) {
      this.options.store.setState(tracked.id, { status: 'pending' });
      return;
    }
    this.options.store.setState(tracked.id, { status: 'queued' });
    this.waiting.push(tracked);
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
    while (this.active < this.options.concurrency() && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next !== undefined && this.options.store.get(next.id) !== undefined) {
        this.active += 1;
        void this.run(next).finally(() => {
          this.active -= 1;
          this.pump();
        });
      }
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
