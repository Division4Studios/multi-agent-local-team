/** Maps a block's review state to its look: outline color, icon and short label. */
import type { HunkState } from '../review/hunkStore';

export type Visual = 'pending' | 'pass' | 'concerns' | 'fail' | 'error';

export const VISUALS: readonly Visual[] = ['pending', 'pass', 'concerns', 'fail', 'error'];

export const visualFor = (state: HunkState): Visual => {
  if (state.status === 'error') {
    return 'error';
  }
  return state.review?.verdict ?? 'pending';
};

/** Theme color ids contributed in package.json. */
export const COLOR_IDS: Readonly<Record<Visual, string>> = {
  pending: 'malt.hunkPending',
  pass: 'malt.hunkPass',
  concerns: 'malt.hunkConcerns',
  fail: 'malt.hunkFail',
  error: 'malt.hunkPending',
};

export const ICONS: Readonly<Record<Visual, string>> = {
  pending: 'circle-large-outline',
  pass: 'pass',
  concerns: 'warning',
  fail: 'error',
  error: 'debug-disconnect',
};

export const VERDICT_LABELS = {
  pass: 'Passed',
  concerns: 'Needs attention',
  fail: 'Changes requested',
};

export const statusLabel = (state: HunkState): string => {
  switch (state.status) {
    case 'pending':
      return 'Waiting for reviewer';
    case 'queued':
      return 'Queued for review';
    case 'reviewing':
      return 'Reviewing…';
    case 'error':
      return 'Review failed';
    case 'reviewed':
      return state.review === undefined ? 'Reviewed' : VERDICT_LABELS[state.review.verdict];
  }
};
