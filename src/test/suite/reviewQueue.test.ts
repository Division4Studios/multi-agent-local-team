/** Regression test for the P2 finding: a block that vanishes while waiting must be reviewable when it returns. */
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { HunkStore } from '../../review/hunkStore';
import type { TrackedHunk } from '../../review/hunkStore';
import { ReviewQueue } from '../../review/reviewQueue';
import type { HunkReviewer } from '../../review/reviewQueue';
import type { HunkReview, ReviewRequest } from '../../shared/protocol';
import { MemoryStorage, deferred, waitFor } from './testUtils';
import type { Deferred } from './testUtils';
import type { TestCase } from './harness';

const REVIEW: HunkReview = { verdict: 'pass', summary: 's', what: 'w', why: 'y', necessity: 'n', checks: [] };

const trackedHunk = (id: string, path: string): TrackedHunk => ({
  id,
  uri: vscode.Uri.file(`/workspace/${path}`),
  relativePath: path,
  hunk: { header: '@@ -1 +1 @@', body: `+${id}`, startLine: 0, endLine: 0, added: 1, removed: 0 },
});

/** A reviewer whose first call blocks until released, so other blocks pile up in the waiting list. */
class GatedReviewer implements HunkReviewer {
  public readonly requests: ReviewRequest[] = [];
  public readonly gate: Deferred<undefined> = deferred<undefined>();

  public async review(request: ReviewRequest): Promise<HunkReview> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      await this.gate.promise;
    }
    return REVIEW;
  }
}

export const tests: readonly TestCase[] = [
  {
    name: 'review queue: a block that vanished while waiting is reviewed when it comes back',
    run: async (): Promise<void> => {
      const store = new HunkStore(new MemoryStorage());
      const reviewer = new GatedReviewer();
      const queue = new ReviewQueue({ store, client: (): HunkReviewer => reviewer, concurrency: (): number => 1 });
      const blocking = trackedHunk('blocking', 'a.ts');
      const vanishing = trackedHunk('vanishing', 'b.ts');
      store.setFileHunks(blocking.uri, [blocking]);
      store.setFileHunks(vanishing.uri, [vanishing]);

      queue.enqueue(blocking);
      queue.enqueue(vanishing);
      assert.equal(store.state(vanishing.id).status, 'queued');

      store.retainFiles(new Set([blocking.uri.toString()]));
      reviewer.gate.resolve(undefined);
      await waitFor(() => store.state(blocking.id).status === 'reviewed', 'blocking block reviewed');
      assert.equal(store.state(vanishing.id).status, 'pending', 'discarded block must not stay "queued"');

      store.setFileHunks(vanishing.uri, [vanishing]);
      queue.enqueue(vanishing);
      await waitFor(() => store.state(vanishing.id).status === 'reviewed', 'restored block reviewed');
      assert.equal(reviewer.requests.length, 2);
      store.dispose();
    },
  },
  {
    name: 'review queue: never sends the same block twice while it is waiting or in flight',
    run: async (): Promise<void> => {
      const store = new HunkStore(new MemoryStorage());
      const reviewer = new GatedReviewer();
      const queue = new ReviewQueue({ store, client: (): HunkReviewer => reviewer, concurrency: (): number => 1 });
      const block = trackedHunk('once', 'a.ts');
      store.setFileHunks(block.uri, [block]);
      queue.enqueue(block);
      queue.enqueue(block, true);
      reviewer.gate.resolve(undefined);
      await waitFor(() => store.state(block.id).status === 'reviewed', 'block reviewed');
      assert.equal(reviewer.requests.length, 1);
      store.dispose();
    },
  },
  {
    name: 'hunk store: ignores persisted reviews that fail validation',
    run: (): void => {
      const storage = new MemoryStorage();
      void storage.update('malt.reviews.v1', { good: REVIEW, bad: { verdict: 'great' } });
      const store = new HunkStore(storage);
      assert.equal(store.state('good').status, 'reviewed');
      assert.equal(store.state('bad').status, 'pending');
      store.dispose();
    },
  },
];
