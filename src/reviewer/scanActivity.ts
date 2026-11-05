/** Tracks each running scan stage's model call and reports it every few seconds, so a stall is visible. */
import type { ScanActivity, ScanProgress, ScanStage } from '../shared/scanProgress';

export const ACTIVITY_INTERVAL_MS = 5_000;

/** The callbacks a stage passes to its model call. */
export interface StageWatch {
  readonly onText: (text: string) => void;
  readonly onActivity: () => void;
}
export interface ActivityTracker {
  readonly begin: (stage: ScanStage) => StageWatch;
  readonly end: (stage: ScanStage) => void;
  /** Reports every running stage now; the timer calls it every ACTIVITY_INTERVAL_MS. */
  readonly tick: () => void;
  readonly stop: () => void;
}
interface Stage { readonly started: number; outputChars: number; last?: number }

export const activitySnapshot = (stage: Stage, now: number): ScanActivity => ({
  elapsedMs: Math.max(0, now - stage.started),
  outputChars: stage.outputChars,
  quietMs: Math.max(0, now - (stage.last ?? stage.started)),
  heard: stage.last !== undefined,
});

export const trackScanActivity = (report: (progress: ScanProgress) => void, now: () => number = Date.now): ActivityTracker => {
  const running = new Map<ScanStage, Stage>();
  const tick = (): void => {
    for (const [stage, state] of running) { report({ stage, state: 'running', activity: activitySnapshot(state, now()) }); }
  };
  const timer = setInterval(tick, ACTIVITY_INTERVAL_MS);
  timer.unref();
  return {
    begin: (stage): StageWatch => {
      const state: Stage = { started: now(), outputChars: 0 };
      running.set(stage, state);
      return {
        onText: (text): void => { state.outputChars += text.length; state.last = now(); },
        onActivity: (): void => { state.last = now(); },
      };
    },
    end: (stage): void => { running.delete(stage); },
    tick,
    stop: (): void => { clearInterval(timer); running.clear(); },
  };
};
