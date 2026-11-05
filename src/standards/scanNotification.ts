import type { Progress } from 'vscode';
import { scanStages } from '../shared/scanProgress';
import type { ScanProgress, ScanStage } from '../shared/scanProgress';

const labels: Readonly<Record<ScanStage, string>> = {
  sources: 'Initial scan', standards: 'Standards', architecture: 'Architecture', gaps: 'Gaps',
};

/** Percent is completed stages, never an estimate of model time or tokens. */
export const scanNotification = (progress: Progress<{ message?: string; increment?: number }>): ((event: ScanProgress) => void) => {
  const states = new Map<ScanStage, ScanProgress['state']>();
  let previous = 0;
  return (event) => {
    states.set(event.stage, event.state);
    const finished = [...states.values()].filter((state) => state !== 'running').length;
    const percent = finished * 25;
    const active = scanStages.filter((stage) => states.get(stage) === 'running').map((stage) => labels[stage]);
    const issues = scanStages.filter((stage) => states.get(stage) === 'failed' || states.get(stage) === 'skipped')
      .map((stage) => `${labels[stage]} ${states.get(stage) ?? ''}`);
    const message = [...active, `${String(finished)} of 4 stages finished (${String(percent)}%)`, ...issues].join(' · ');
    progress.report({ increment: percent - previous, message });
    previous = percent;
  };
};
