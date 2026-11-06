/**
 * Which review providers this machine can use, and their models. Runs only on a user action (a command or the
 * Models & effort tray): the first Copilot lookup shows VS Code's consent dialog, which the Language Model API
 * allows only in response to the user. Detection reads status only; it never signs in or sends code anywhere.
 */
import * as vscode from 'vscode';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { Credentials } from '../backend/credentials';
import { DockerClient, defaultDockerSocket } from '../backend/dockerApi';
import { readSettings } from '../config';
import { AUTO_MODEL, PROVIDERS, PROVIDER_LABELS } from '../shared/reviewProfiles';
import type { ProviderId } from '../shared/reviewProfiles';

export interface ProviderModel {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}
export interface ProviderStatus {
  readonly provider: ProviderId;
  readonly available: boolean;
  readonly detail: string;
  readonly models: readonly ProviderModel[];
}

/** Claude's model aliases; a full model id can also be typed in the tray. */
export const CLAUDE_MODELS: readonly ProviderModel[] = [
  { id: 'haiku', label: 'haiku', detail: 'Fastest, uses the least' },
  { id: 'sonnet', label: 'sonnet', detail: 'Balanced' },
  { id: 'opus', label: 'opus', detail: 'Most thorough, uses the most' },
];

const isExecutable = async (path: string, platform: NodeJS.Platform): Promise<boolean> => {
  try {
    await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Where a command could be, by `platform`'s path rules: itself if it is a path, else each PATH folder (with Windows' extensions). */
export const commandCandidates = (command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] => {
  const paths = platform === 'win32' ? win32 : posix;
  const extensions = platform === 'win32' ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')] : [''];
  const isPath = paths.isAbsolute(command) || command.includes('/') || command.includes('\\');
  const folders = isPath ? [''] : (env['PATH'] ?? '').split(paths.delimiter).filter((dir) => dir !== '');
  return command === '' ? [] : folders.flatMap((folder) => extensions.map((ext) => (folder === '' ? `${command}${ext}` : paths.join(folder, `${command}${ext}`))));
};

/**
 * Whether a command names an executable file. It only looks for the file: extension code may start processes in two
 * reviewed files only, and detection is not one of them.
 */
export const findOnPath = async (command: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<boolean> => {
  for (const candidate of commandCandidates(command, env, platform)) {
    if (await isExecutable(candidate, platform)) {
      return true;
    }
  }
  return false;
};

const claudeStatus = async (credentials: Credentials): Promise<ProviderStatus> => {
  const [stored, cli] = await Promise.all([credentials.hasAny(), findOnPath(readSettings().claudePath)]);
  const found = [stored ? 'credentials stored for the Docker reviewer' : '', cli ? 'Claude Code CLI on PATH (host reviewer)' : ''].filter((part) => part !== '');
  return {
    provider: 'claude',
    available: found.length > 0,
    detail: found.length > 0 ? found.join(' · ') : 'No Claude credentials stored and no Claude Code CLI on PATH',
    models: CLAUDE_MODELS,
  };
};

const copilotStatus = async (): Promise<ProviderStatus> => {
  try {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return {
      provider: 'copilot',
      available: models.length > 0,
      detail: models.length > 0 ? `${String(models.length)} models` : 'No Copilot models: sign in to GitHub Copilot in VS Code, and allow MALT to use it',
      models: models.map((model) => ({ id: model.id, label: model.name, detail: `${model.family} · ${String(model.maxInputTokens)} input tokens` })),
    };
  } catch (error: unknown) {
    return { provider: 'copilot', available: false, detail: error instanceof Error ? error.message : String(error), models: [] };
  }
};

/** Codex's own default model; any other Codex model id can be typed in the tray. */
export const CODEX_MODELS: readonly ProviderModel[] = [{ id: AUTO_MODEL, label: AUTO_MODEL, detail: 'Codex’s default model' }];

/** Codex runs in a container per call: it needs Docker and an OpenAI API key stored in MALT. */
const codexStatus = async (credentials: Credentials): Promise<ProviderStatus> => {
  const setting = readSettings().dockerSocketPath;
  const [key, docker] = await Promise.all([credentials.codexApiKey(), new DockerClient(setting === '' ? defaultDockerSocket() : setting).ping()]);
  const missing = [key === undefined ? 'no OpenAI API key stored (MALT: Set Codex Credentials)' : '', docker ? '' : 'Docker is not running'].filter((part) => part !== '');
  return {
    provider: 'codex',
    available: missing.length === 0,
    detail: missing.length === 0 ? 'OpenAI API key stored · Docker running (one isolated container per call)' : `Not ready: ${missing.join('; ')}`,
    models: CODEX_MODELS,
  };
};

const providerStatus = async (provider: ProviderId, credentials: Credentials): Promise<ProviderStatus> => {
  switch (provider) {
    case 'claude':
      return await claudeStatus(credentials);
    case 'copilot':
      return await copilotStatus();
    case 'codex':
      return await codexStatus(credentials);
  }
};

/** Every provider's status. Call only from a user action (Copilot consent). */
export const detectProviders = async (credentials: Credentials): Promise<readonly ProviderStatus[]> =>
  await Promise.all(PROVIDERS.map(async (provider) => await providerStatus(provider, credentials)));

/** "MALT: Detect Review Providers": what is available, then where to choose. */
export const showProviders = async (credentials: Credentials): Promise<void> => {
  const statuses = await detectProviders(credentials);
  await vscode.window.showQuickPick(
    statuses.map((status) => ({
      label: `${status.available ? '$(pass-filled)' : '$(circle-slash)'} ${PROVIDER_LABELS[status.provider]}`,
      description: status.available ? 'available' : 'not available',
      detail: status.detail,
    })),
    { title: 'MALT review providers', placeHolder: 'Choose a provider per review type under Models & effort in the MALT Reviewer view', ignoreFocusOut: true },
  );
};
