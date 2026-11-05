/**
 * Provider, model and effort per review type, edited from the Reviewer view's "Models & effort" row. Choices are written to
 * the same settings as the Settings UI (keeping a workspace-level value at workspace level). They take effect when
 * the reviewer restarts; `watchReviewSettings` offers that restart.
 */
import * as vscode from 'vscode';
import { readSettings } from '../config';
import { EFFORTS, PROVIDER_LABELS, REVIEW_TYPES, REVIEW_TYPE_INFO, isModelName, takesEffort } from '../shared/reviewProfiles';
import type { Effort, ProviderId, ReviewType } from '../shared/reviewProfiles';
import type { Credentials } from '../backend/credentials';
import { detectProviders } from './providerDetection';
import type { ProviderStatus } from './providerDetection';

const EFFORT_NOTES: Readonly<Record<Effort, string>> = {
  default: 'Claude Code’s own default',
  low: 'Quickest, least usage',
  medium: 'Balanced',
  high: 'Deeper reasoning, more usage',
  xhigh: 'Much deeper reasoning',
  max: 'Most thorough, most usage',
};

const CUSTOM = 'Custom model id…';

const isReviewType = (value: unknown): value is ReviewType => REVIEW_TYPES.some((type) => type === value);

const pickProvider = async (type: ReviewType, current: ProviderId, statuses: readonly ProviderStatus[]): Promise<ProviderStatus | undefined> => {
  const items = statuses.map((status) => ({
    label: PROVIDER_LABELS[status.provider],
    description: `${status.available ? 'available' : 'not available'}${status.provider === current ? ' · current' : ''}`,
    detail: status.detail,
    status,
  }));
  const choice = await vscode.window.showQuickPick(items, { title: `${REVIEW_TYPE_INFO[type].label}: provider`, placeHolder: 'Who answers these calls', ignoreFocusOut: true });
  if (choice !== undefined && !choice.status.available) {
    void vscode.window.showWarningMessage(`${PROVIDER_LABELS[choice.status.provider]} is not available: ${choice.status.detail}`);
    return undefined;
  }
  return choice?.status;
};

const pickModel = async (type: ReviewType, status: ProviderStatus, current: string): Promise<string | undefined> => {
  const info = REVIEW_TYPE_INFO[type];
  const custom = status.provider === 'claude' ? [{ label: CUSTOM, description: '', id: CUSTOM }] : [];
  const items = [...status.models.map((model) => ({ label: model.label, description: `${model.detail}${model.id === current ? ' · current' : ''}`, id: model.id })), ...custom];
  const choice = await vscode.window.showQuickPick(items, { title: `${info.label}: ${PROVIDER_LABELS[status.provider]} model`, placeHolder: info.detail, ignoreFocusOut: true });
  if (choice?.id !== CUSTOM) {
    return choice?.id;
  }
  return await vscode.window.showInputBox({
    title: `${info.label}: custom model id`,
    value: current,
    ignoreFocusOut: true,
    validateInput: (text) => (isModelName(text) ? undefined : 'Use a model alias or id, e.g. claude-sonnet-5-5'),
  });
};

const pickEffort = async (type: ReviewType, current: Effort): Promise<Effort | undefined> => {
  const items = EFFORTS.map((effort) => ({ label: effort, effort, description: `${EFFORT_NOTES[effort]}${effort === current ? ' · current' : ''}` }));
  const choice = await vscode.window.showQuickPick(items, { title: `${REVIEW_TYPE_INFO[type].label}: effort`, ignoreFocusOut: true });
  return choice?.effort;
};

/** Writes where the value already lives, so a workspace setting is not silently shadowed by a user one. */
const targetFor = (key: string): vscode.ConfigurationTarget => {
  const inspected = vscode.workspace.getConfiguration('malt').inspect(key);
  if (inspected?.workspaceFolderValue !== undefined) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  return inspected?.workspaceValue === undefined ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace;
};

/**
 * Provider, then that provider's model, then (for providers that take one) effort. This is a user action, so the
 * provider lookup may show Copilot's consent dialog. The provider setting is machine-scoped, so it is written to the
 * user's settings; model and effort keep their existing workspace or user level.
 */
export const configureReviewType = async (type: unknown, credentials: Credentials): Promise<void> => {
  if (!isReviewType(type)) {
    return;
  }
  const current = readSettings().profiles[type];
  const status = await pickProvider(type, current.provider, await detectProviders(credentials));
  if (status === undefined) {
    return;
  }
  const model = await pickModel(type, status, status.provider === current.provider ? current.model : '');
  if (model === undefined || !isModelName(model)) {
    return;
  }
  const effort = takesEffort(status.provider) ? await pickEffort(type, current.effort) : current.effort;
  if (effort === undefined) {
    return;
  }
  const info = REVIEW_TYPE_INFO[type];
  const config = vscode.workspace.getConfiguration('malt');
  await config.update(info.providerSetting, status.provider, vscode.ConfigurationTarget.Global);
  await config.update(info.modelSetting, model, targetFor(info.modelSetting));
  await config.update(info.effortSetting, effort, targetFor(info.effortSetting));
};

/** Whether a configuration change touches any review type's provider, model or effort. */
export const affectsReviewProfiles = (event: vscode.ConfigurationChangeEvent): boolean =>
  REVIEW_TYPES.some((type) => {
    const info = REVIEW_TYPE_INFO[type];
    return [info.providerSetting, info.modelSetting, info.effortSetting].some((key) => event.affectsConfiguration(`malt.${key}`));
  });

/** After model or effort settings change, offers one restart (changes made together are batched). */
export const watchReviewSettings = (isRunning: () => boolean, restart: () => Promise<void>): vscode.Disposable => {
  let timer: NodeJS.Timeout | undefined;
  const subscription = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!affectsReviewProfiles(event) || !isRunning()) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      void vscode.window
        .showInformationMessage('MALT: review model settings changed. They apply when the reviewer restarts.', 'Restart Now')
        .then(async (choice) => {
          if (choice === 'Restart Now') {
            await restart();
          }
        });
    }, 800);
  });
  return new vscode.Disposable(() => {
    clearTimeout(timer);
    subscription.dispose();
  });
};
