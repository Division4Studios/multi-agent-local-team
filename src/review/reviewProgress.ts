/** Derived facts about a block's review: which rules still need a check, how each rule stands, and the verdict. */
import type { HunkReview, Rule, RuleCheck } from '../shared/protocol';

/** How a rule stands for one block, in the order the Changes view lists them. */
export type RuleRun = 'running' | 'fail' | 'pass' | 'not-run' | 'not-applicable';

export const RULE_RUN_ORDER: readonly RuleRun[] = ['running', 'fail', 'pass', 'not-run', 'not-applicable'];

export interface RuleRow {
  readonly rule: Rule;
  readonly run: RuleRun;
  readonly check?: RuleCheck;
}

/** Applicable rules that have no check yet. */
export const missingRules = (review: HunkReview): Rule[] => {
  const applicable = new Set(review.overview.applicable);
  const checked = new Set(review.checks.map((check) => check.ruleId));
  return review.rules.filter((rule) => applicable.has(rule.id) && !checked.has(rule.id));
};

/** "fail" as soon as any rule fails, "pass" once every applicable rule passed, otherwise undefined (in progress). */
export const verdictOf = (review: HunkReview): 'pass' | 'fail' | undefined => {
  if (review.checks.some((check) => check.status === 'fail')) {
    return 'fail';
  }
  return missingRules(review).length === 0 ? 'pass' : undefined;
};

const rowFor = (rule: Rule, review: HunkReview, running: ReadonlySet<string>): RuleRow => {
  const check = review.checks.find((candidate) => candidate.ruleId === rule.id);
  if (check !== undefined) {
    return { rule, run: check.status, check };
  }
  if (running.has(rule.id)) {
    return { rule, run: 'running' };
  }
  return { rule, run: review.overview.applicable.includes(rule.id) ? 'not-run' : 'not-applicable' };
};

/** Every rule with its standing, sorted running → failed → passed → not run → not applicable. */
export const ruleRows = (review: HunkReview, running: readonly string[] = []): RuleRow[] => {
  const runningIds = new Set(running);
  return review.rules
    .map((rule) => rowFor(rule, review, runningIds))
    .sort((a, b) => RULE_RUN_ORDER.indexOf(a.run) - RULE_RUN_ORDER.indexOf(b.run));
};
