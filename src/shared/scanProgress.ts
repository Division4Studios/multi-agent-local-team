import { isRecord } from './guards';

export const scanStages = ['sources', 'standards', 'architecture', 'gaps'] as const;
export type ScanStage = (typeof scanStages)[number];
export interface ScanProgress {
  readonly stage: ScanStage;
  readonly state: 'running' | 'complete' | 'skipped' | 'failed';
}
export const parseScanProgress = (value: unknown): ScanProgress | undefined => {
  if (!isRecord(value)) { return undefined; }
  const stage = scanStages.find((item) => item === value['stage']);
  const state = value['state'];
  return stage !== undefined && (state === 'running' || state === 'complete' || state === 'skipped' || state === 'failed')
    ? { stage, state } : undefined;
};
