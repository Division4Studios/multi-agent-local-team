/**
 * Sends changed blocks to the reviewer with bounded concurrency. Each block gets one overview call, then one
 * isolated call per applicable rule; the concurrency limit counts calls, not blocks.
 *
 * The queue is the source of truth for what is waiting and in flight (`busy` counts each block's tasks); the
 * store's status is only a display of it. "Busy" is never inferred from a displayed status, so a block whose
 * status went stale (e.g. it vanished while waiting) can always be queued again.
 */
import type { CheckRequest, OverviewResponse, ReviewRequest, Rule, RuleCheck } from '../shared/protocol';
import type { HunkState, HunkStore, TrackedHunk } from './hunkStore';
import { missingRules } from './reviewProgress';

/** The capabilities the queue needs from the reviewer. */
export interface HunkReviewer {
  review: (request: ReviewRequest) => Promise<OverviewResponse>;
  check: (request: CheckRequest) => Promise<RuleCheck>;
}

export interface QueueOptions {
  readonly store: HunkStore;
  readonly client: () => HunkReviewer | undefined;
  readonly concurrency: () => number;
}

/** An overview call for a block, or (with `rule`) one rule check. */
interface Task {
  readonly tracked: TrackedHunk;
  readonly rule?: Rule;
}

const requestFor = (tracked: TrackedHunk): ReviewRequest => ({
  filePath: tracked.relativePath,
  startLine: tracked.hunk.startLine,
  endLine: tracked.hunk.endLine,
  patch: `${tracked.hunk.header}\n${tracked.hunk.body}`,
});

const withoutError = ({ status, review }: HunkState): HunkState => (review === undefined ? { status } : { status, review });

export class ReviewQueue {
  private readonly waiting: Task[] = [];
  private readonly busy = new Map<string, number>();
  private inFlight = 0;
  private readonly options: QueueOptions;

  public constructor(options: QueueOptions) {
    this.options = options;
  }

  /**
   * Queues a block unless it is already busy. Reviewed blocks are skipped unless `force`. A block with an overview
   * but missing rule checks resumes with just those checks; `force` starts over from the overview.
   */
  public enqueue(tracked: TrackedHunk, force = false): void {
    const { store } = this.options;
    const state = store.state(tracked.id);
    if (this.busy.has(tracked.id) || (!force && state.status === 'reviewed')) {
      return;
    }
    if (this.options.client() === undefined) {
      store.setState(tracked.id, { ...withoutError(state), status: 'pending' });
      return;
    }
    const missing = force || state.review === undefined ? [] : missingRules(state.review);
    if (missing.length > 0 && state.review !== undefined) {
      store.setState(tracked.id, { status: 'reviewing', review: state.review });
      this.push(missing.map((rule) => ({ tracked, rule })));
    } else {
      store.setState(tracked.id, { status: 'queued' });
      this.push([{ tracked }]);
    }
    this.pump();
  }

  /** Queues every tracked block whose review is missing or incomplete (e.g. once the reviewer comes online). */
  public enqueueUnreviewed(): void {
    for (const tracked of this.options.store.allHunks()) {
      const { status } = this.options.store.state(tracked.id);
      if (status === 'pending' || status === 'error') {
        this.enqueue(tracked);
      }
    }
  }

  /** Adds tasks; `first` puts them ahead of other blocks so a started block finishes before the next begins. */
  private push(tasks: readonly Task[], first = false): void {
    for (const task of tasks) {
      this.busy.set(task.tracked.id, (this.busy.get(task.tracked.id) ?? 0) + 1);
    }
    if (first) {
      this.waiting.unshift(...tasks);
    } else {
      this.waiting.push(...tasks);
    }
  }

  private pump(): void {
    while (this.inFlight < this.options.concurrency()) {
      const task = this.waiting.shift();
      if (task === undefined) {
        return;
      }
      this.inFlight += 1;
      void this.run(task).finally(() => {
        this.inFlight -= 1;
        this.finish(task.tracked.id);
        this.pump();
      });
    }
  }

  private async run(task: Task): Promise<void> {
    const client = this.options.client();
    const { id } = task.tracked;
    // The reviewer went away, or the block vanished while waiting: `finish` leaves it reviewable later.
    if (client === undefined || this.options.store.get(id) === undefined) {
      return;
    }
    try {
      await (task.rule === undefined ? this.runOverview(client, task.tracked) : this.runCheck(client, task.tracked, task.rule));
    } catch (error: unknown) {
      this.update(id, (state) => ({ ...state, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private async runOverview(client: HunkReviewer, tracked: TrackedHunk): Promise<void> {
    this.options.store.setState(tracked.id, { status: 'reviewing' });
    const response = await client.review(requestFor(tracked));
    const review = { ...response, checks: [] };
    this.options.store.setState(tracked.id, { status: 'reviewing', review });
    this.push(missingRules(review).map((rule) => ({ tracked, rule })), true);
  }

  private async runCheck(client: HunkReviewer, tracked: TrackedHunk, rule: Rule): Promise<void> {
    const running = (state: HunkState): readonly string[] => (state.running ?? []).filter((ruleId) => ruleId !== rule.id);
    this.update(tracked.id, (state) => ({ ...state, running: [...running(state), rule.id] }));
    try {
      const check = await client.check({ ...requestFor(tracked), ruleId: rule.id });
      this.update(tracked.id, (state) => (state.review === undefined ? state : {
        ...state,
        review: { ...state.review, checks: [...state.review.checks.filter((other) => other.ruleId !== rule.id), check] },
      }));
    } finally {
      this.update(tracked.id, (state) => ({ ...state, running: running(state) }));
    }
  }

  private update(id: string, change: (state: HunkState) => HunkState): void {
    this.options.store.setState(id, change(this.options.store.state(id)));
  }

  /** When a block's last task is done, its status says whether it is complete, failed or still owes checks. */
  private finish(id: string): void {
    const remaining = (this.busy.get(id) ?? 0) - 1;
    if (remaining > 0) {
      this.busy.set(id, remaining);
      return;
    }
    this.busy.delete(id);
    const state = this.options.store.state(id);
    const { review, error } = state;
    if (review !== undefined && missingRules(review).length === 0) {
      this.options.store.setState(id, { status: 'reviewed', review });
    } else if (error !== undefined) {
      this.options.store.setState(id, { ...withoutError(state), status: 'error', error });
    } else {
      this.options.store.setState(id, { ...withoutError(state), status: 'pending' });
    }
  }
}
