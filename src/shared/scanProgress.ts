import { isRecord } from './guards';

export const scanStages = ['sources', 'standards', 'architecture', 'gaps'] as const;
export type ScanStage = (typeof scanStages)[number];

/**
 * What a running stage's model call is doing, sent every few seconds so the UI can tell a long answer from a stall.
 * `heard` is whether the model has sent anything yet (answer text or thinking); `quietMs` is the time since it last
 * did, or since the stage started if it never has.
 */
export interface ScanActivity {
  readonly elapsedMs: number;
  readonly outputChars: number;
  readonly quietMs: number;
  readonly heard: boolean;
}
export interface ScanProgress {
  readonly stage: ScanStage;
  readonly state: 'running' | 'complete' | 'skipped' | 'failed';
  readonly activity?: ScanActivity;
}

const DAY_MS = 86_400_000;
const isCount = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
const parseActivity = (value: unknown): ScanActivity | undefined =>
  isRecord(value) && isCount(value['elapsedMs'], DAY_MS) && isCount(value['outputChars'], 1_000_000_000)
    && isCount(value['quietMs'], DAY_MS) && typeof value['heard'] === 'boolean'
    ? { elapsedMs: value['elapsedMs'], outputChars: value['outputChars'], quietMs: value['quietMs'], heard: value['heard'] }
    : undefined;

/** A malformed activity is dropped, never the progress event: it is display only. */
export const parseScanProgress = (value: unknown): ScanProgress | undefined => {
  if (!isRecord(value)) { return undefined; }
  const stage = scanStages.find((item) => item === value['stage']);
  const state = value['state'];
  if (stage === undefined || (state !== 'running' && state !== 'complete' && state !== 'skipped' && state !== 'failed')) { return undefined; }
  const activity = state === 'running' ? parseActivity(value['activity']) : undefined;
  return activity === undefined ? { stage, state } : { stage, state, activity };
};
