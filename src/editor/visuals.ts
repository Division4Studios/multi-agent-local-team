/** Maps a block's review state to its look: outline color, icon and short label. */
import type { HunkState } from '../review/hunkStore';
import { missingRules, verdictOf } from '../review/reviewProgress';
import type { RuleRun } from '../review/reviewProgress';

export type Visual = 'pending' | 'pass' | 'fail' | 'error';

export const VISUALS: readonly Visual[] = ['pending', 'pass', 'fail', 'error'];

/** A block turns red as soon as one rule fails, even while other rules are still being checked. */
export const visualFor = (state: HunkState): Visual => {
  const verdict = state.review === undefined ? undefined : verdictOf(state.review);
  if (verdict === 'fail') {
    return 'fail';
  }
  if (state.status === 'error') {
    return 'error';
  }
  return verdict ?? 'pending';
};

/** Theme color ids contributed in package.json. */
export const COLOR_IDS: Readonly<Record<Visual, string>> = {
  pending: 'malt.hunkPending',
  pass: 'malt.hunkPass',
  fail: 'malt.hunkFail',
  error: 'malt.hunkPending',
};

export const ICONS: Readonly<Record<Visual, string>> = {
  pending: 'circle-large-outline',
  pass: 'pass',
  fail: 'error',
  error: 'debug-disconnect',
};

export const VERDICT_LABELS = {
  pass: 'Passed',
  fail: 'Changes requested',
};

export const RUN_LABELS: Readonly<Record<RuleRun, string>> = {
  running: 'running',
  fail: 'failed',
  pass: 'passed',
  'not-run': 'not run yet',
  'not-applicable': 'not applicable',
};

const progressLabel = (state: HunkState): string => {
  if (state.review === undefined) {
    return 'Reviewing…';
  }
  const total = state.review.overview.applicable.length;
  return `Checking rules ${String(total - missingRules(state.review).length)}/${String(total)}…`;
};

export const statusLabel = (state: HunkState): string => {
  switch (state.status) {
    case 'pending':
      return 'Waiting for reviewer';
    case 'queued':
      return 'Queued for review';
    case 'reviewing':
      return progressLabel(state);
    case 'error':
      return 'Review failed';
    case 'reviewed':
      return VERDICT_LABELS[visualFor(state) === 'fail' ? 'fail' : 'pass'];
  }
};
