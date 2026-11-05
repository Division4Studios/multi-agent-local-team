/** Review queue: one overview call per block, then one call per applicable rule, with resumable progress. */
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { HunkStore } from '../../review/hunkStore';
import type { TrackedHunk } from '../../review/hunkStore';
import { ReviewQueue } from '../../review/reviewQueue';
import type { HunkReviewer } from '../../review/reviewQueue';
import { ruleRows, verdictOf } from '../../review/reviewProgress';
import { ReviewerHttpError } from '../../review/reviewerClient';
import type { CheckRequest, OverviewResponse, ReviewRequest, RuleCheck } from '../../shared/protocol';
import { MemoryStorage, deferred, testCheck, testReview, testRule, waitFor } from './testUtils';
import type { Deferred } from './testUtils';
import type { TestCase } from './harness';

const RULES = [testRule('a'), testRule('b'), testRule('skipped')];
const OVERVIEW: OverviewResponse = { overview: testReview(RULES, ['a', 'b']).overview, rules: RULES };

const trackedHunk = (id: string, path: string): TrackedHunk => ({
  id,
  uri: vscode.Uri.file(`/workspace/${path}`),
  relativePath: path,
  hunk: { header: '@@ -1 +1 @@', body: `+${id}`, startLine: 0, endLine: 0, added: 1, removed: 0 },
});

/** A reviewer whose first overview blocks until released, so other blocks pile up in the waiting list. */
class GatedReviewer implements HunkReviewer {
  public readonly requests: ReviewRequest[] = [];
  public readonly checks: CheckRequest[] = [];
  public readonly gate: Deferred<undefined> = deferred<undefined>();
  public failRule: string | undefined;

  public async review(request: ReviewRequest): Promise<OverviewResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      await this.gate.promise;
    }
    return OVERVIEW;
  }

  public async check(request: CheckRequest): Promise<RuleCheck> {
    this.checks.push(request);
    const rule = RULES.find((candidate) => candidate.id === request.ruleId);
    if (rule === undefined) {
      throw new ReviewerHttpError(409, `Unknown rule: ${request.ruleId}`);
    }
    if (rule.id === this.failRule) {
      throw new Error('check failed');
    }
    return await Promise.resolve(testCheck(rule, rule.id === 'a' ? 'fail' : 'pass'));
  }
}

const setup = (concurrency = 1): { store: HunkStore; reviewer: GatedReviewer; queue: ReviewQueue } => {
  const store = new HunkStore(new MemoryStorage());
  const reviewer = new GatedReviewer();
  const queue = new ReviewQueue({ store, client: (): HunkReviewer => reviewer, concurrency: (): number => concurrency });
  return { store, reviewer, queue };
};

export const tests: readonly TestCase[] = [
  {
    name: 'review queue: a block that vanished while waiting is reviewed when it comes back',
    run: async (): Promise<void> => {
      const { store, reviewer, queue } = setup();
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
      const { store, reviewer, queue } = setup();
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
    name: 'review queue: checks each applicable rule in its own call and sorts the results',
    run: async (): Promise<void> => {
      const { store, reviewer, queue } = setup(2);
      const block = trackedHunk('rules', 'a.ts');
      store.setFileHunks(block.uri, [block]);
      reviewer.gate.resolve(undefined);
      queue.enqueue(block);
      await waitFor(() => store.state(block.id).status === 'reviewed', 'block reviewed');
      assert.deepEqual(reviewer.checks.map((request) => request.ruleId).sort(), ['a', 'b'], 'not-applicable rule is never checked');
      const { review } = store.state(block.id);
      assert.ok(review !== undefined);
      assert.deepEqual(ruleRows(review).map((row) => [row.rule.id, row.run]), [['a', 'fail'], ['b', 'pass'], ['skipped', 'not-applicable']]);
      store.dispose();
    },
  },
  {
    name: 'review queue: a failed rule check leaves the block in error and a retry runs only that rule',
    run: async (): Promise<void> => {
      const { store, reviewer, queue } = setup();
      const block = trackedHunk('retry', 'a.ts');
      store.setFileHunks(block.uri, [block]);
      reviewer.gate.resolve(undefined);
      reviewer.failRule = 'b';
      queue.enqueue(block);
      await waitFor(() => store.state(block.id).status === 'error', 'block errored');
      assert.equal(store.state(block.id).review?.checks.length, 1, 'the successful check is kept');
      reviewer.failRule = undefined;
      queue.enqueueUnreviewed();
      await waitFor(() => store.state(block.id).status === 'reviewed', 'block reviewed');
      assert.equal(reviewer.requests.length, 1, 'no second overview');
      assert.deepEqual(reviewer.checks.map((request) => request.ruleId), ['a', 'b', 'b']);
      store.dispose();
    },
  },
  {
    name: 'review queue: a saved review naming a rule the reviewer no longer has starts over from the overview',
    run: async (): Promise<void> => {
      const { store, reviewer, queue } = setup(2);
      const block = trackedHunk('stale', 'a.ts');
      store.setFileHunks(block.uri, [block]);
      reviewer.gate.resolve(undefined);
      store.setState(block.id, { status: 'pending', review: testReview([...RULES, testRule('renamed'), testRule('gone')], ['a', 'renamed', 'gone']) });
      queue.enqueue(block);
      await waitFor(() => store.state(block.id).status === 'reviewed', 'block reviewed');
      assert.equal(store.state(block.id).error, undefined, 'a stale rule is not reported as an error');
      assert.equal(reviewer.requests.length, 1, 'one fresh overview, not one per stale rule');
      assert.deepEqual(store.state(block.id).review?.rules.map((rule) => rule.id), RULES.map((rule) => rule.id), 'the current rule list replaces the saved one');
      store.dispose();
    },
  },
  {
    name: 'review queue: a check still in flight when its block restarts never lands in the new review',
    run: async (): Promise<void> => {
      const store = new HunkStore(new MemoryStorage());
      const held = deferred<undefined>();
      const kept = testRule('a');
      const checks: string[] = [];
      let overviews = 0;
      const reviewer: HunkReviewer = {
        // The current standards no longer make any rule applicable to this block.
        review: async (): Promise<OverviewResponse> => { overviews += 1; return await Promise.resolve({ overview: testReview(RULES, []).overview, rules: RULES }); },
        check: async (request: CheckRequest): Promise<RuleCheck> => {
          checks.push(request.ruleId);
          if (request.ruleId === 'gone') { throw new ReviewerHttpError(409, 'Unknown rule: gone'); }
          await held.promise;
          return testCheck(kept, 'fail');
        },
      };
      const queue = new ReviewQueue({ store, client: (): HunkReviewer => reviewer, concurrency: (): number => 2 });
      const block = trackedHunk('restart-race', 'a.ts');
      store.setFileHunks(block.uri, [block]);
      store.setState(block.id, { status: 'pending', review: testReview([kept, testRule('gone')], ['a', 'gone']) });
      queue.enqueue(block);
      await waitFor(() => overviews === 1 && store.state(block.id).review !== undefined, 'restarted overview stored');
      held.resolve(undefined);
      await waitFor(() => store.state(block.id).status === 'reviewed', 'block reviewed');
      const { review, error } = store.state(block.id);
      assert.deepEqual(checks.sort(), ['a', 'gone'], 'the old check was in flight during the restart');
      assert.equal(error, undefined);
      assert.ok(review !== undefined);
      assert.equal(verdictOf(review), 'pass', 'a review with no applicable rules is not failed by a stale result');
      assert.equal(review.checks.length, 0, 'the failure from the old generation is dropped');
      store.dispose();
    },
  },
  {
    name: 'hunk store: ignores persisted reviews that fail validation and resumes partial ones',
    run: (): void => {
      const storage = new MemoryStorage();
      const [first] = RULES;
      assert.ok(first !== undefined);
      const complete = testReview(RULES, ['a'], [testCheck(first, 'pass')]);
      void storage.update('malt.reviews.v1', { good: complete, partial: testReview(RULES, ['a']), bad: { verdict: 'great' } });
      const store = new HunkStore(storage);
      assert.equal(store.state('good').status, 'reviewed');
      assert.equal(store.state('partial').status, 'pending');
      assert.ok(store.state('partial').review !== undefined);
      assert.equal(store.state('bad').status, 'pending');
      store.dispose();
    },
  },
];
