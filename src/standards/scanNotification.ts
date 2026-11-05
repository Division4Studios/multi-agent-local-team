import type { Progress } from 'vscode';
import { scanStages } from '../shared/scanProgress';
import type { ScanActivity, ScanProgress, ScanStage } from '../shared/scanProgress';

const labels: Readonly<Record<ScanStage, string>> = {
  sources: 'Initial scan', standards: 'Standards', architecture: 'Architecture', gaps: 'Gaps',
};

/** Nothing at all from the model (answer text, thinking or status) for this long reads as a possible stall. */
export const STALL_MS = 120_000;

const duration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${String(seconds)}s` : `${String(Math.floor(seconds / 60))}m ${String(seconds % 60).padStart(2, '0')}s`;
};
const characters = (count: number): string => (count < 1000 ? `${String(count)} characters` : `${(count / 1000).toFixed(1)}k characters`);

/** One running stage, in words: waiting, thinking, writing, or possibly stalled. */
export const describeStage = (label: string, activity: ScanActivity | undefined): string => {
  if (activity === undefined) {
    return `${label}: starting`;
  }
  if (activity.quietMs >= STALL_MS) {
    return `${label}: no response for ${duration(activity.quietMs)}, may be stalled (MALT: Show Live Reviewer Log)`;
  }
  if (!activity.heard) {
    return `${label}: waiting for the model (${duration(activity.elapsedMs)})`;
  }
  return activity.outputChars === 0
    ? `${label}: model is thinking (${duration(activity.elapsedMs)})`
    : `${label}: writing, ${characters(activity.outputChars)} so far (${duration(activity.elapsedMs)})`;
};

/**
 * Percent is completed stages, never an estimate of model time or tokens. The message says what each running stage
 * is doing, refreshed every few seconds from the reviewer, so a long answer can be told from a stalled call.
 */
export const scanNotification = (progress: Progress<{ message?: string; increment?: number }>): ((event: ScanProgress) => void) => {
  const latest = new Map<ScanStage, ScanProgress>();
  let previous = 0;
  return (event) => {
    latest.set(event.stage, event);
    const events = scanStages.flatMap((stage) => latest.get(stage) ?? []);
    const finished = events.filter((item) => item.state !== 'running').length;
    const percent = finished * 25;
    const active = events.filter((item) => item.state === 'running').map((item) => describeStage(labels[item.stage], item.activity));
    const issues = events.filter((item) => item.state === 'failed' || item.state === 'skipped').map((item) => `${labels[item.stage]} ${item.state}`);
    const message = [...active, `${String(finished)} of 4 stages done`, ...issues].join(' · ');
    progress.report({ increment: percent - previous, message });
    previous = percent;
  };
};
