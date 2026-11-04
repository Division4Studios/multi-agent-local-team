/**
 * One pull request under review: stopping it (on Finish, or when its checkout changes) must leave nothing running
 * and record nothing late, and its findings must never be confused with local ones.
 */
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { PullRequestReview } from '../../pullRequest/pullRequestReview';
import type { PullRequestReviewOptions } from '../../pullRequest/pullRequestReview';
import { HunkStore } from '../../review/hunkStore';
import { ReviewQueue } from '../../review/reviewQueue';
import { ConsolidationCheck } from '../../review/consolidation';
import { findingsFor } from '../../commands';
import type { CheckRequest, ConsolidationRequest, Finding, OverviewResponse, ReviewRequest, RuleCheck } from '../../shared/protocol';
import { MemoryStorage, deferred, testCheck, testReview, testRule } from './testUtils';
import { HEAD_SHA, pause, summary, tracked } from './pullRequestFakes';
import type { TestCase } from './harness';

const finding = (title: string): Finding => ({ title, files: ['a.ts'], note: 'n', detail: 'd', anchors: [] });

const RULE = testRule('a');
const OVERVIEW: OverviewResponse = { overview: testReview([RULE], ['a']).overview, rules: [RULE] };

/** Stopping a review: queued blocks never start, an overview that lands later is dropped and queues no checks, and stop waits. */
const queueStops = async (): Promise<void> => {
  const store = new HunkStore(new MemoryStorage());
  const gate = deferred<undefined>();
  const reviews: ReviewRequest[] = [];
  const checks: CheckRequest[] = [];
  const reviewer = {
    review: async (request: ReviewRequest): Promise<OverviewResponse> => {
      reviews.push(request);
      await gate.promise;
      return OVERVIEW;
    },
    check: async (request: CheckRequest): Promise<RuleCheck> => {
      checks.push(request);
      return await Promise.resolve(testCheck(RULE, 'pass'));
    },
  };
  const queue = new ReviewQueue({ store, client: (): typeof reviewer => reviewer, concurrency: (): number => 1 });
  for (const block of [tracked('one'), tracked('two')]) {
    store.setFileHunks(block.uri, [block]);
    queue.enqueue(block);
  }
  let stopped = false;
  const stopping = queue.stop().then(() => {
    stopped = true;
  });
  await pause();
  assert.equal(stopped, false, 'stop waits for the call in flight');
  gate.resolve(undefined);
  await stopping;
  queue.enqueue(tracked('three'));
  await pause();
  assert.deepEqual(reviews.map((request) => request.filePath), ['one.ts'], 'queued and new blocks never start');
  assert.deepEqual(checks, [], 'the overview that finished after stop scheduled no rule checks');
  assert.equal(store.state('one').review, undefined, 'the overview that finished after stop is dropped, not recorded');
  store.dispose();
};

const consolidationStops = async (): Promise<void> => {
  const store = new HunkStore(new MemoryStorage());
  const gate = deferred<undefined>();
  const requests: ConsolidationRequest[] = [];
  const check = new ConsolidationCheck(store, () => ({
    consolidation: async (request: ConsolidationRequest): Promise<readonly Finding[]> => {
      requests.push(request);
      await gate.promise;
      return [finding('read after stop')];
    },
  }));
  const running = check.run();
  let stopped = false;
  const stopping = check.stop().then(() => {
    stopped = true;
  });
  await pause();
  assert.equal(stopped, false, 'stop waits for the check in flight');
  gate.resolve(undefined);
  await Promise.all([running, stopping]);
  await check.run();
  check.schedule();
  assert.equal(requests.length, 1, 'no check runs after stop');
  assert.deepEqual(check.state, { status: 'idle', findings: [] }, 'findings that arrive after stop are dropped');
  vscode.Disposable.from(check, store).dispose();
};

/** Finding commands resolve against the review the finding came from, never the other one. */
const findingsRouteBySource = async (): Promise<void> => {
  const store = new HunkStore(new MemoryStorage());
  const local = new ConsolidationCheck(store, () => ({
    consolidation: async (): Promise<readonly Finding[]> => await Promise.resolve([finding('local')]),
  }));
  const pullRequest = new PullRequestReview({
    pull: summary(7, HEAD_SHA),
    previous: { treeish: 'main', label: 'main' },
    blocks: [tracked('pr')],
    skipped: [],
    client: (): ReturnType<PullRequestReviewOptions['client']> => ({
      review: async (): Promise<OverviewResponse> => await Promise.resolve(OVERVIEW),
      check: async (): Promise<RuleCheck> => await Promise.resolve(testCheck(RULE, 'pass')),
      consolidation: async (): Promise<readonly Finding[]> => await Promise.resolve([finding('pull request')]),
    }),
    concurrency: (): number => 1,
  });
  try {
    await Promise.all([local.run(), pullRequest.consolidation.run()]);
    const [top] = pullRequest.tree.getChildren();
    assert.ok(top !== undefined);
    const [findingNode] = pullRequest.tree.getChildren(top);
    assert.ok(findingNode !== undefined);
    assert.deepEqual(pullRequest.tree.getTreeItem(findingNode).command?.arguments, [0, 0, 'pullRequest']);
    const deps = { consolidation: local, pullRequest: (): PullRequestReview => pullRequest };
    assert.deepEqual(findingsFor(deps, 'pullRequest').map((item) => item.title), ['pull request']);
    assert.deepEqual(findingsFor(deps, 'changes').map((item) => item.title), ['local']);
    const closed = { consolidation: local, pullRequest: (): undefined => undefined };
    assert.deepEqual(findingsFor(closed, 'pullRequest'), [], 'a closed review resolves to nothing, never to local findings');
  } finally {
    vscode.Disposable.from(pullRequest, local, store).dispose();
  }
};

/** An invalidated review stops for good: nothing more is sent, and it says why. */
const invalidatedReviewStops = async (): Promise<void> => {
  const reviews: ReviewRequest[] = [];
  const consolidations: ConsolidationRequest[] = [];
  const review = new PullRequestReview({
    pull: summary(7, HEAD_SHA),
    previous: { treeish: 'main', label: 'main' },
    blocks: [tracked('pr')],
    skipped: [],
    client: (): ReturnType<PullRequestReviewOptions['client']> => ({
      review: async (request: ReviewRequest): Promise<OverviewResponse> => {
        reviews.push(request);
        return await Promise.resolve(OVERVIEW);
      },
      check: async (): Promise<RuleCheck> => await Promise.resolve(testCheck(RULE, 'pass')),
      consolidation: async (request: ConsolidationRequest): Promise<readonly Finding[]> => {
        consolidations.push(request);
        return await Promise.resolve([]);
      },
    }),
    concurrency: (): number => 1,
  });
  try {
    assert.equal(review.stale, undefined);
    assert.equal(review.invalidate('files of the pull request checkout were changed'), true);
    assert.equal(review.invalidate('again'), false, 'the first reason is kept');
    assert.equal(review.stale, 'files of the pull request checkout were changed');
    review.reviewAll();
    await pause();
    assert.deepEqual([reviews.length, consolidations.length], [0, 0], 'no call is made once the checkout changed');
  } finally {
    review.dispose();
  }
};

export const tests: readonly TestCase[] = [
  { name: 'review queue: stop drops waiting work and late results, schedules nothing new, and waits for calls in flight', run: queueStops },
  { name: 'consolidation: stop cancels scheduled checks, waits for the one in flight and drops its findings', run: consolidationStops },
  { name: 'pull requests: consolidation findings open from the review they belong to', run: findingsRouteBySource },
  { name: 'pull requests: a review whose checkout changed stops for good and says why', run: invalidatedReviewStops },
];
