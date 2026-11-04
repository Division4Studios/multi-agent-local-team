/** MALT command handlers. */
import * as vscode from 'vscode';
import type { ReviewerManager } from './backend/reviewerManager';
import type { Credentials } from './backend/credentials';
import type { HunkStore, TrackedHunk } from './review/hunkStore';
import type { ReviewQueue } from './review/reviewQueue';
import { scanStandards, showSavedGaps } from './standards/scanStandards';
import { showFinding, showRuleCheck } from './views/detailPanel';
import type { ConsolidationCheck } from './review/consolidation';
import { isNonNegativeInteger, isRecord, isString } from './shared/guards';
import type { StandardsModel } from './standards/standardsModel';
import type { FindingHighlight } from './editor/findingHighlight';
import type { AttentionGuard } from './editor/attention';
import { registerStandardsCommands, showFindingLocation } from './standards/standardsCommands';
import { ConversationPanel } from './views/conversationPanel';
import type { PullRequestReview } from './pullRequest/pullRequestReview';
import { configureReviewType } from './views/reviewSettings';

export interface CommandDeps {
  readonly store: HunkStore;
  readonly manager: ReviewerManager;
  readonly queue: ReviewQueue;
  readonly consolidation: ConsolidationCheck;
  readonly credentials: Credentials;
  readonly output: vscode.LogOutputChannel;
  readonly standards: StandardsModel;
  readonly highlight: FindingHighlight;
  readonly attention: AttentionGuard;
  /** The extension's install location, for webview resources (the live log script). */
  readonly extensionUri: vscode.Uri;
  /** The pull request under review, if any: its blocks are looked up before local changes. */
  readonly pullRequest: () => PullRequestReview | undefined;
}

/** Registers a command that opens something for the user to look at; running it pauses auto-open (see AttentionGuard). */
const userCommand = (deps: CommandDeps, id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable =>
  vscode.commands.registerCommand(id, (...args: unknown[]) => {
    deps.attention.noteUserActivity();
    return handler(...args);
  });

const workspaceFolder = (): vscode.WorkspaceFolder | undefined => vscode.workspace.workspaceFolders?.[0];

/**
 * Which review a block belongs to: the pull request under review if it has the block, else local changes. The
 * hover, sidebar and detail commands are shared, so they must resolve against the right store and queue.
 */
const ownerOf = (deps: CommandDeps, id: string, startLine?: unknown): { readonly store: HunkStore; readonly queue: ReviewQueue } => {
  const review = deps.pullRequest();
  const line = isNonNegativeInteger(startLine) ? startLine : undefined;
  return review?.find(id, line) === undefined ? { store: deps.store, queue: deps.queue } : { store: review.store, queue: review.queue };
};

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
      const owner = id === undefined ? undefined : ownerOf(deps, id);
      const tracked = id === undefined ? undefined : owner?.store.get(id);
      if (owner !== undefined && tracked !== undefined) {
        owner.queue.enqueue(tracked, true);
      }
    }),
    userCommand(deps, 'malt.revealHunk', async (arg: unknown, startLine: unknown) => {
      const id = hunkIdFrom(arg);
      await revealTrackedHunk(id === undefined ? deps.store : ownerOf(deps, id, startLine).store, arg, startLine);
    }),
    userCommand(deps, 'malt.showRuleCheck', (id: unknown, startLine: unknown, ruleId: unknown) => {
      showRuleCheck(isString(id) ? ownerOf(deps, id, startLine).store : deps.store, id, startLine, ruleId);
    }),
    vscode.commands.registerCommand('malt.checkConsolidation', async () => {
      if (deps.manager.client === undefined) {
        void vscode.window.showWarningMessage('Start the MALT reviewer to check consolidation.');
        return;
      }
      await deps.consolidation.run();
    }),
    userCommand(deps, 'malt.showStandardsGaps', async () => {
      const folder = workspaceFolder();
      if (folder !== undefined) {
        await showSavedGaps(folder);
      }
    }),
    registerViewCommands(deps),
  );

/** Commands that open findings, the live log and settings, plus the Standards/Gaps/Architecture commands. */
const registerViewCommands = (deps: CommandDeps): vscode.Disposable =>
  vscode.Disposable.from(
    userCommand(deps, 'malt.showFinding', (arg: unknown) => {
      const index = isRecord(arg) ? arg['index'] : arg;
      showFinding(deps.consolidation.state.findings, index);
    }),
    userCommand(deps, 'malt.showFindingLocation', async (index: unknown, anchorIndex: unknown) => {
      const finding = isNonNegativeInteger(index) ? deps.consolidation.state.findings[index] : undefined;
      if (finding !== undefined) {
        const target = { folder: workspaceFolder(), finding, kind: 'Consolidation' };
        await showFindingLocation(deps.highlight, target, anchorIndex, () => {
          showFinding(deps.consolidation.state.findings, index);
        });
      }
    }),
    vscode.commands.registerCommand('malt.configureReviewType', async (type: unknown) => {
      await configureReviewType(type);
    }),
    userCommand(deps, 'malt.showLiveLog', () => {
      ConversationPanel.show(deps.manager, deps.extensionUri);
    }),
    registerStandardsCommands({
      standards: deps.standards,
      highlight: deps.highlight,
      scan: async () => { await runScan(deps); },
      onUserFocus: () => { deps.attention.noteUserActivity(); },
      reviewer: async () => {
        if (deps.manager.client === undefined) {
          await startReviewer(deps);
        }
        return deps.manager.client;
      },
    }),
  );
