/**
 * Model and effort per review type, edited from the Reviewer view's "Models & effort" row. Choices are written to
 * the same settings as the Settings UI (keeping a workspace-level value at workspace level). They take effect when
 * the reviewer restarts; `watchReviewSettings` offers that restart.
 */
import * as vscode from 'vscode';
import { readSettings } from '../config';
import { EFFORTS, REVIEW_TYPES, REVIEW_TYPE_INFO, isModelName } from '../shared/reviewProfiles';
import type { Effort, ReviewType } from '../shared/reviewProfiles';

const MODELS: readonly { readonly id: string; readonly note: string }[] = [
  { id: 'haiku', note: 'Fastest, uses the least' },
  { id: 'sonnet', note: 'Balanced' },
  { id: 'opus', note: 'Most thorough, uses the most' },
];

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

const pickModel = async (type: ReviewType, current: string): Promise<string | undefined> => {
  const info = REVIEW_TYPE_INFO[type];
  const items = [...MODELS.map((model) => ({ label: model.id, description: `${model.note}${model.id === current ? ' · current' : ''}` })), { label: CUSTOM, description: '' }];
  const choice = await vscode.window.showQuickPick(items, { title: `${info.label}: model`, placeHolder: info.detail, ignoreFocusOut: true });
  if (choice?.label !== CUSTOM) {
    return choice?.label;
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

export const configureReviewType = async (type: unknown): Promise<void> => {
  if (!isReviewType(type)) {
    return;
  }
  const current = readSettings().profiles[type];
  const model = await pickModel(type, current.model);
  if (model === undefined || !isModelName(model)) {
    return;
  }
  const effort = await pickEffort(type, current.effort);
  if (effort === undefined) {
    return;
  }
  const info = REVIEW_TYPE_INFO[type];
  const config = vscode.workspace.getConfiguration('malt');
  await config.update(info.modelSetting, model, targetFor(info.modelSetting));
  await config.update(info.effortSetting, effort, targetFor(info.effortSetting));
};

/** Whether a configuration change touches any review type's model or effort. */
export const affectsReviewProfiles = (event: vscode.ConfigurationChangeEvent): boolean =>
  REVIEW_TYPES.some((type) => {
    const info = REVIEW_TYPE_INFO[type];
    return event.affectsConfiguration(`malt.${info.modelSetting}`) || event.affectsConfiguration(`malt.${info.effortSetting}`);
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
