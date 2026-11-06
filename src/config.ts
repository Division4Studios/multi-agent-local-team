/** Typed access to MALT settings. */
import * as vscode from 'vscode';
import { REVIEW_TYPE_INFO, profileFrom } from './shared/reviewProfiles';
import type { CallProfile, ReviewProfiles, ReviewType } from './shared/reviewProfiles';

export type BackendSetting = 'auto' | 'docker' | 'host';

export interface MaltSettings {
  readonly backend: BackendSetting;
  readonly autoStart: boolean;
  /** Provider, model and effort for each kind of model call. */
  readonly profiles: ReviewProfiles;
  readonly maxConcurrentReviews: number;
  readonly claudePath: string;
  readonly dockerSocketPath: string;
  readonly autoOpen: boolean;
  /** Seconds of no user activity before auto-open may move the editor again. */
  readonly autoOpenPauseSeconds: number;
  readonly autoReview: boolean;
  readonly autoConsolidation: boolean;
}

const readProfile = (config: vscode.WorkspaceConfiguration, type: ReviewType): CallProfile => {
  const info = REVIEW_TYPE_INFO[type];
  const provider = config.get<unknown>(info.providerSetting, 'claude');
  // Each provider has its own model setting, so a provider is never paired with another provider's model.
  const model = config.get<unknown>(provider === 'copilot' ? info.copilotModelSetting : info.modelSetting);
  return profileFrom(type, model, config.get<unknown>(info.effortSetting), provider);
};

/** Invalid values (e.g. a hand-edited setting) fall back to that type's default. */
const readProfiles = (config: vscode.WorkspaceConfiguration): ReviewProfiles => ({
  overview: readProfile(config, 'overview'),
  check: readProfile(config, 'check'),
  consolidation: readProfile(config, 'consolidation'),
  standards: readProfile(config, 'standards'),
  investigation: readProfile(config, 'investigation'),
});

const readBackend = (value: string): BackendSetting => (value === 'docker' || value === 'host' ? value : 'auto');

export const readSettings = (): MaltSettings => {
  const config = vscode.workspace.getConfiguration('malt');
  return {
    backend: readBackend(config.get<string>('reviewer.backend', 'auto')),
    autoStart: config.get<boolean>('reviewer.autoStart', true),
    profiles: readProfiles(config),
    maxConcurrentReviews: Math.max(1, config.get<number>('reviewer.maxConcurrentReviews', 2)),
    claudePath: config.get<string>('reviewer.claudePath', 'claude'),
    dockerSocketPath: config.get<string>('docker.socketPath', ''),
    autoOpen: config.get<boolean>('changes.autoOpen', true),
    autoOpenPauseSeconds: Math.max(0, config.get<number>('changes.autoOpenPauseSeconds', 60)),
    autoReview: config.get<boolean>('changes.autoReview', true),
    autoConsolidation: config.get<boolean>('changes.autoConsolidation', true),
  };
};
