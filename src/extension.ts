/**
 * MALT extension entry point: wires change tracking, the review queue, editor outlines/hovers,
 * the sidebar and the reviewer backend together.
 */
import * as vscode from 'vscode';
import { readSettings } from './config';
import { Credentials } from './backend/credentials';
import { ReviewerManager } from './backend/reviewerManager';
import { HunkStore } from './review/hunkStore';
import { ReviewQueue } from './review/reviewQueue';
import { ConsolidationCheck } from './review/consolidation';
import type { HunkReviewer } from './review/reviewQueue';
import { ChangeTracker } from './review/changeTracker';
import type { NewHunksEvent } from './review/changeTracker';
import { getGitApi } from './git/gitApi';
import { HunkDecorations } from './editor/decorations';
import { ReviewHoverProvider } from './editor/reviewMarkdown';
import { ChangesTreeProvider } from './views/changesView';
import { ReviewerTreeProvider } from './views/reviewerView';
import { StandardsModel } from './standards/standardsModel';
import { FindingHighlight } from './editor/findingHighlight';
import { AttentionGuard } from './editor/attention';
import { watchReviewSettings } from './views/reviewSettings';
import { PullRequestController } from './pullRequest/pullRequestController';
import type { PullRequestReview } from './pullRequest/pullRequestReview';
import { createStatusBar } from './views/statusBar';
import { registerCommands, revealHunk, startReviewer } from './commands';
import type { CommandDeps } from './commands';

/** On start-up, existing changes are only auto-reviewed if there are few of them (to avoid surprise cost). */
const INITIAL_AUTO_REVIEW_LIMIT = 25;
/** New files are where parallel components appear, so they trigger the (debounced) consolidation check. */
const scheduleConsolidation = (deps: CommandDeps, event: NewHunksEvent): void => {
  const hasNewFile = event.hunks.some((tracked) => tracked.hunk.header.startsWith('@@ -0,0 '));
  if (readSettings().autoConsolidation && !event.initial && hasNewFile) {
    deps.consolidation.schedule();
  }
};

const onNewHunks = (deps: CommandDeps, event: NewHunksEvent): void => {
  const settings = readSettings();
  const tooManyAtStartup = event.initial && deps.store.allHunks().length > INITIAL_AUTO_REVIEW_LIMIT;
  if (settings.autoReview && !tooManyAtStartup) {
    for (const tracked of event.hunks) {
      deps.queue.enqueue(tracked);
    }
  }
  scheduleConsolidation(deps, event);
  if (settings.autoOpen && !event.initial) {
    autoOpen(deps, event);
  }
};

/** Brings the new change into view, unless the user is already there or busy with something else. */
const autoOpen = (deps: CommandDeps, event: NewHunksEvent): void => {
  const first = event.hunks[0];
  const isActive = vscode.window.activeTextEditor?.document.uri.toString() === event.uri.toString();
  if (first !== undefined && !isActive && deps.attention.allowsAutoOpen()) {
    void deps.attention.navigate(async () => {
      await revealHunk(first);
    });
  }
};

let backlogPrompted = false;

/** Reviews blocks that changed while the reviewer was offline; asks first if there are many. */
const reviewBacklog = async (deps: CommandDeps): Promise<void> => {
  const unreviewed = deps.store.allHunks().filter((tracked) => deps.store.state(tracked.id).status === 'pending');
  if (unreviewed.length <= INITIAL_AUTO_REVIEW_LIMIT) {
    deps.queue.enqueueUnreviewed();
    return;
  }
  if (backlogPrompted) {
    return;
  }
  backlogPrompted = true;
  const choice = await vscode.window.showInformationMessage(
    `MALT found ${String(unreviewed.length)} unreviewed changed blocks. Review them all now?`,
    'Review All',
  );
  if (choice === 'Review All') {
    deps.queue.enqueueUnreviewed();
  }
};

const startTracking = async (context: vscode.ExtensionContext, deps: CommandDeps): Promise<void> => {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const git = await getGitApi();
  if (folder === undefined || git === undefined) {
    return;
  }
  const tracker = new ChangeTracker(git, folder, deps.store);
  context.subscriptions.push(tracker, tracker.onDidFindNewHunks((event) => {
    onNewHunks(deps, event);
  }));
};

/** The Pull Request view: its own review session, sharing the reviewer and the user's attention guard. */
const createPullRequests = (deps: CommandDeps): { readonly controller: PullRequestController; readonly disposable: vscode.Disposable } => {
  const controller = new PullRequestController({
    manager: deps.manager,
    startReviewer: async (): Promise<void> => {
      await startReviewer(deps);
    },
  });
  const commands = controller.registerCommands(() => {
    deps.attention.noteUserActivity();
  });
  return { controller, disposable: vscode.Disposable.from(controller, commands) };
};

export const activate = async (context: vscode.ExtensionContext): Promise<void> => {
  const output = vscode.window.createOutputChannel('MALT Reviewer', { log: true });
  const store = new HunkStore(context.workspaceState);
  const credentials = new Credentials(context.secrets);
  const manager = new ReviewerManager(context.extensionUri.fsPath, credentials, output);
  const queue = new ReviewQueue({
    store,
    client: (): HunkReviewer | undefined => manager.client,
    concurrency: (): number => readSettings().maxConcurrentReviews,
  });
  const consolidation = new ConsolidationCheck(store, () => manager.client);
  const standards = new StandardsModel(vscode.workspace.workspaceFolders?.[0]);
  const highlight = new FindingHighlight();
  const attention = new AttentionGuard(() => readSettings().autoOpenPauseSeconds * 1000);
  // Late-bound: the controller needs deps, and deps exposes the controller's active review.
  const pullRequests: { current?: PullRequestController } = {};
  const deps: CommandDeps = {
    store,
    manager,
    queue,
    consolidation,
    credentials,
    output,
    standards,
    highlight,
    attention,
    extensionUri: context.extensionUri,
    pullRequest: (): PullRequestReview | undefined => pullRequests.current?.active,
  };
  const pullRequestFeature = createPullRequests(deps);
  pullRequests.current = pullRequestFeature.controller;

  context.subscriptions.push(
    output,
    store,
    consolidation,
    standards,
    highlight,
    attention,
    manager,
    new HunkDecorations(store),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, new ReviewHoverProvider(store)),
    vscode.window.registerTreeDataProvider('malt.reviewer', new ReviewerTreeProvider(manager, store, standards)),
    vscode.window.registerTreeDataProvider('malt.changes', new ChangesTreeProvider(store, consolidation)),
    createStatusBar(manager, store),
    registerCommands(deps),
    pullRequestFeature.disposable,
    watchReviewSettings(() => manager.status.state === 'running', async () => {
      await startReviewer(deps);
    }),
    manager.onDidChangeStatus((status) => {
      if (status.state === 'running' && readSettings().autoReview) {
        void reviewBacklog(deps);
      }
    }),
  );
  await vscode.commands.executeCommand('setContext', 'malt.reviewerState', 'stopped');
  await startTracking(context, deps);

  if (vscode.workspace.workspaceFolders !== undefined && readSettings().autoStart) {
    void startReviewer(deps);
  }
};
