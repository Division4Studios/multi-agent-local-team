/** Typed access to MALT settings. */
import * as vscode from 'vscode';

export type BackendSetting = 'auto' | 'docker' | 'host';

export interface MaltSettings {
  readonly backend: BackendSetting;
  readonly autoStart: boolean;
  readonly triageModel: string;
  readonly reviewModel: string;
  readonly standardsModel: string;
  readonly maxConcurrentReviews: number;
  readonly claudePath: string;
  readonly dockerSocketPath: string;
  readonly autoOpen: boolean;
  readonly autoReview: boolean;
  readonly autoConsolidation: boolean;
}

const readBackend = (value: string): BackendSetting => (value === 'docker' || value === 'host' ? value : 'auto');

export const readSettings = (): MaltSettings => {
  const config = vscode.workspace.getConfiguration('malt');
  return {
    backend: readBackend(config.get<string>('reviewer.backend', 'auto')),
    autoStart: config.get<boolean>('reviewer.autoStart', true),
    triageModel: config.get<string>('reviewer.triageModel', 'sonnet'),
    reviewModel: config.get<string>('reviewer.reviewModel', 'sonnet'),
    standardsModel: config.get<string>('reviewer.standardsModel', 'opus'),
    maxConcurrentReviews: Math.max(1, config.get<number>('reviewer.maxConcurrentReviews', 2)),
    claudePath: config.get<string>('reviewer.claudePath', 'claude'),
    dockerSocketPath: config.get<string>('docker.socketPath', ''),
    autoOpen: config.get<boolean>('changes.autoOpen', true),
    autoReview: config.get<boolean>('changes.autoReview', true),
    autoConsolidation: config.get<boolean>('changes.autoConsolidation', true),
  };
};
