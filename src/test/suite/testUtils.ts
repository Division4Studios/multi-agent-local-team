/** Small helpers shared by tests. */
import type { ReviewCacheStorage } from '../../review/hunkStore';
import type { CheckStatus, HunkReview, Rule, RuleCheck } from '../../shared/protocol';

export const testRule = (id: string, category = 'Style'): Rule => ({ id, title: `Rule ${id}`, check: `${id}?`, category, source: 'CLAUDE.md' });

export const testCheck = (rule: Rule, status: CheckStatus): RuleCheck => ({ ruleId: rule.id, title: rule.title, status, note: `${rule.id} ${status}`, detail: 'd' });

/** A review over `rules` where `applicable` lists the rule ids worth a check. */
export const testReview = (rules: readonly Rule[], applicable: readonly string[], checks: readonly RuleCheck[] = []): HunkReview => ({
  overview: { summary: 'Same content', purpose: 'p', technical: 't', design: 'd', applicable },
  rules,
  checks,
});

export class MemoryStorage implements ReviewCacheStorage {
  private readonly values = new Map<string, unknown>();

  public get(key: string): unknown {
    return this.values.get(key);
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    await Promise.resolve();
  }
}

/** Polls `condition` until it holds or the timeout elapses; fails with `message` on timeout. */
export const waitFor = async (condition: () => boolean, message: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${message}`);
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 25);
    });
  }
};

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export const deferred = <T>(): Deferred<T> => {
  let resolveFn: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolveFn = resolvePromise;
  });
  return {
    promise,
    resolve: (value: T): void => {
      resolveFn?.(value);
    },
  };
};
