/** MALT command handlers. */
import * as vscode from 'vscode';
import type { ReviewerManager } from './backend/reviewerManager';
import type { Credentials } from './backend/credentials';
import type { HunkStore, TrackedHunk } from './review/hunkStore';
import type { ReviewQueue } from './review/reviewQueue';
import { scanStandards } from './standards/scanStandards';
import { isNonNegativeInteger, isRecord, isString } from './shared/guards';

export interface CommandDeps {
  readonly store: HunkStore;
  readonly manager: ReviewerManager;
  readonly queue: ReviewQueue;
  readonly credentials: Credentials;
  readonly output: vscode.LogOutputChannel;
}

const workspaceFolder = (): vscode.WorkspaceFolder | undefined => vscode.workspace.workspaceFolders?.[0];

/** Accepts a hunk id (hover link) or a tree node (`{ tracked }`) and returns the id. */
const hunkIdFrom = (arg: unknown): string | undefined => {
  if (isString(arg)) {
    return arg;
  }
  const tracked = isRecord(arg) ? arg['tracked'] : undefined;
  return isRecord(tracked) && isString(tracked['id']) ? tracked['id'] : undefined;
};

export const revealHunk = async (tracked: TrackedHunk): Promise<void> => {
  const range = new vscode.Range(tracked.hunk.startLine, 0, tracked.hunk.startLine, 0);
  const editor = await vscode.window.showTextDocument(tracked.uri, { preview: true, preserveFocus: true, selection: range });
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
};

/** Resolve command arguments against current tracked blocks; never trust a caller-supplied file or range. */
export const revealTrackedHunk = async (store: HunkStore, arg: unknown, startLine?: unknown): Promise<void> => {
  const id = hunkIdFrom(arg);
  if (id === undefined || (startLine !== undefined && !isNonNegativeInteger(startLine))) {
    return;
  }
  const tracked = store.get(id, startLine);
  if (tracked !== undefined) {
    await revealHunk(tracked);
  }
};

export const startReviewer = async (deps: CommandDeps): Promise<void> => {
  const folder = workspaceFolder();
  if (folder === undefined) {
    void vscode.window.showWarningMessage('MALT needs an open workspace folder to start the reviewer.');
    return;
  }
  try {
    await deps.manager.start(folder.uri.fsPath);
  } catch (error: unknown) {
    const choice = await vscode.window.showErrorMessage(
      `MALT reviewer failed to start: ${error instanceof Error ? error.message : String(error)}`,
      'Show Logs',
      'Set Credentials',
    );
    if (choice === 'Show Logs') {
      deps.output.show();
    } else if (choice === 'Set Credentials') {
      await vscode.commands.executeCommand('malt.setCredentials');
    }
  }
};

const runScan = async (deps: CommandDeps): Promise<void> => {
  const folder = workspaceFolder();
  if (folder === undefined) {
    void vscode.window.showWarningMessage('MALT needs an open workspace folder to scan standards.');
    return;
  }
  if (deps.manager.client === undefined) {
    await startReviewer(deps);
  }
  const client = deps.manager.client;
  if (client === undefined) {
    return;
  }
  try {
    await scanStandards(client, folder);
  } catch (error: unknown) {
    void vscode.window.showErrorMessage(`MALT standards scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const showLogs = async (deps: CommandDeps): Promise<void> => {
  if (deps.manager.status.backend === 'docker') {
    deps.output.info(`----- container logs -----\n${await deps.manager.logs()}`);
  }
  deps.output.show();
};

const setCredentials = async (deps: CommandDeps): Promise<void> => {
  if (!(await deps.credentials.promptAndStore())) {
    return;
  }
  const choice = await vscode.window.showInformationMessage('MALT credentials saved. Restart the reviewer to use them?', 'Restart');
  if (choice === 'Restart') {
    await startReviewer(deps);
  }
};

export const registerCommands = (deps: CommandDeps): vscode.Disposable =>
  vscode.Disposable.from(
    vscode.commands.registerCommand('malt.startReviewer', async () => { await startReviewer(deps); }),
    vscode.commands.registerCommand('malt.stopReviewer', async () => { await deps.manager.stop(); }),
    vscode.commands.registerCommand('malt.scanStandards', async () => { await runScan(deps); }),
    vscode.commands.registerCommand('malt.showReviewerLogs', async () => { await showLogs(deps); }),
    vscode.commands.registerCommand('malt.setCredentials', async () => { await setCredentials(deps); }),
    vscode.commands.registerCommand('malt.clearCredentials', async () => { await deps.credentials.clear(); }),
    vscode.commands.registerCommand('malt.reviewAll', () => {
      deps.queue.enqueueUnreviewed();
    }),
    vscode.commands.registerCommand('malt.reviewAgain', (arg: unknown) => {
      const id = hunkIdFrom(arg);
      const tracked = id === undefined ? undefined : deps.store.get(id);
      if (tracked !== undefined) {
        deps.queue.enqueue(tracked, true);
      }
    }),
    vscode.commands.registerCommand('malt.revealHunk', async (arg: unknown, startLine: unknown) => {
      await revealTrackedHunk(deps.store, arg, startLine);
    }),
  );
