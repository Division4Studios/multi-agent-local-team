/**
 * "Review Pull Request": pick an open PR on the workspace's GitHub repository, check it out (safely; see
 * pullRequestCheckout.ts), turn GitHub's diff into blocks, and review them in the Pull Request view with the same
 * outlines, hover cards, rule checks and consolidation as local changes. Results stay in VS Code; nothing is posted.
 * "Finish" returns to the previous branch. Signing in uses VS Code's built-in GitHub authentication.
 */
import * as vscode from 'vscode';
import { isAbsolute, relative } from 'node:path';
import { readSettings } from '../config';
import { describeProfile } from '../shared/reviewProfiles';
import { getGitApi } from '../git/gitApi';
import type { GitRepository } from '../git/gitApi';
import { GitHubClient } from '../github/githubApi';
import type { PullRequestSummary } from '../github/githubApi';
import type { ReviewerManager } from '../backend/reviewerManager';
import type { ReviewerClient } from '../review/reviewerClient';
import type { ChangesNode } from '../views/changesView';
import { checkOutPullRequest, findGitHubRemote, returnFromPullRequest } from './pullRequestCheckout';
import type { GitHubRemote } from './pullRequestCheckout';
import { blocksFromFiles } from './pullRequestBlocks';
import { PullRequestReview } from './pullRequestReview';

export interface PullRequestDeps {
  readonly manager: ReviewerManager;
  readonly startReviewer: () => Promise<void>;
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const repositoryFor = async (folder: vscode.WorkspaceFolder): Promise<GitRepository | undefined> => {
  const git = await getGitApi();
  return git?.repositories.find((repository) => {
    const fromRoot = relative(repository.rootUri.fsPath, folder.uri.fsPath);
    return !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
  });
};

/** The workspace folder, its git repository and the GitHub remote to take pull requests from. */
const reviewTarget = async (): Promise<{ readonly folder: vscode.WorkspaceFolder; readonly repository: GitRepository; readonly remote: GitHubRemote } | undefined> => {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const repository = folder === undefined ? undefined : await repositoryFor(folder);
  const remote = repository === undefined ? undefined : findGitHubRemote(repository);
  return folder === undefined || repository === undefined || remote === undefined ? undefined : { folder, repository, remote };
};

const pickPullRequest = async (client: GitHubClient): Promise<PullRequestSummary | undefined> => {
  const pulls = await client.openPullRequests();
  if (pulls.length === 0) {
    void vscode.window.showInformationMessage('This repository has no open pull requests.');
    return undefined;
  }
  const choice = await vscode.window.showQuickPick(
    pulls.map((pull) => ({ label: `#${String(pull.number)} ${pull.title}`, description: `by ${pull.author} · ${pull.headRef} → ${pull.baseRef}`, pull })),
    { title: 'MALT: Review a pull request', placeHolder: 'Choose an open pull request', matchOnDescription: true },
  );
  return choice?.pull;
};

export class PullRequestController implements vscode.TreeDataProvider<ChangesNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<undefined>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly deps: PullRequestDeps;
  private readonly view: vscode.TreeView<ChangesNode>;
  private review: PullRequestReview | undefined;
  private reviewSubscriptions: vscode.Disposable[] = [];

  public constructor(deps: PullRequestDeps) {
    this.deps = deps;
    this.view = vscode.window.createTreeView('malt.pullRequest', { treeDataProvider: this });
    void vscode.commands.executeCommand('setContext', 'malt.pullRequestActive', false);
  }

  public get active(): PullRequestReview | undefined {
    return this.review;
  }

  public getChildren(node?: ChangesNode): ChangesNode[] {
    return this.review?.tree.getChildren(node) ?? [];
  }

  public getTreeItem(node: ChangesNode): vscode.TreeItem {
    return this.review?.tree.getTreeItem(node) ?? new vscode.TreeItem('');
  }

  public async start(): Promise<void> {
    if (this.review !== undefined) {
      void vscode.window.showWarningMessage(`Finish reviewing #${String(this.review.pull.number)} before starting another.`);
      return;
    }
    const target = await reviewTarget();
    if (target === undefined) {
      void vscode.window.showWarningMessage('MALT needs a git repository with a github.com remote to review a pull request.');
      return;
    }
    const { folder, repository, remote } = target;
    try {
      const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
      const client = new GitHubClient(remote.repo, session.accessToken);
      const pull = await pickPullRequest(client);
      if (pull === undefined || !(await this.confirmCheckout(pull, repository))) {
        return;
      }
      const previous = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `MALT: Checking out #${String(pull.number)}…` },
        async () => await checkOutPullRequest(repository, remote.remote, pull),
      );
      const { blocks, skipped } = await blocksFromFiles(folder, repository.rootUri, await client.files(pull.number));
      this.open(new PullRequestReview({
        pull,
        previous,
        blocks,
        skipped,
        client: (): ReviewerClient | undefined => this.deps.manager.client,
        concurrency: (): number => readSettings().maxConcurrentReviews,
      }));
      await this.offerReview();
    } catch (error: unknown) {
      void vscode.window.showErrorMessage(`MALT could not review the pull request: ${describeError(error)}`);
    }
  }

  public async finish(): Promise<void> {
    const review = this.review;
    const folder = vscode.workspace.workspaceFolders?.[0];
    const repository = folder === undefined ? undefined : await repositoryFor(folder);
    if (review === undefined || repository === undefined) {
      return;
    }
    try {
      await returnFromPullRequest(repository, review.previous);
      this.close();
      void vscode.window.showInformationMessage(`Finished reviewing #${String(review.pull.number)}. Back on ${review.previous.label}.`);
    } catch (error: unknown) {
      void vscode.window.showErrorMessage(`MALT could not finish the review: ${describeError(error)}`);
    }
  }

  /** Reviews every block not yet reviewed, after saying what it will cost. */
  public async reviewAll(): Promise<void> {
    const review = this.review;
    if (review === undefined) {
      return;
    }
    const { overview, check, consolidation } = readSettings().profiles;
    const choice = await vscode.window.showWarningMessage(
      `Review #${String(review.pull.number)}: ${String(review.blockCount)} block(s) in ${String(review.fileCount)} file(s)? ` +
        `Each block is one overview call (${describeProfile(overview)}) plus one call per applicable rule (${describeProfile(check)}), ` +
        `then one consolidation call for the whole PR (${describeProfile(consolidation)}).`,
      { modal: true },
      'Review All',
    );
    if (choice !== 'Review All') {
      return;
    }
    if (this.deps.manager.client === undefined) {
      await this.deps.startReviewer();
    }
    if (this.deps.manager.client !== undefined) {
      review.reviewAll();
    }
  }

  /** Opens the PR on github.com; the URL comes from the API, so only a github.com https URL is opened. */
  public async openOnGitHub(): Promise<void> {
    const url = this.review?.pull.htmlUrl;
    if (url?.startsWith('https://github.com/') === true) {
      await vscode.env.openExternal(vscode.Uri.parse(url, true));
    }
  }

  /** The Pull Request view's commands. `onUserFocus` pauses auto-open while the user starts a review. */
  public registerCommands(onUserFocus: () => void): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.commands.registerCommand('malt.reviewPullRequest', async () => {
        onUserFocus();
        await this.start();
      }),
      vscode.commands.registerCommand('malt.finishPullRequestReview', async () => {
        await this.finish();
      }),
      vscode.commands.registerCommand('malt.reviewPullRequestBlocks', async () => {
        await this.reviewAll();
      }),
      vscode.commands.registerCommand('malt.openPullRequestOnGitHub', async () => {
        await this.openOnGitHub();
      }),
    );
  }

  public dispose(): void {
    this.close();
    this.view.dispose();
    this.changeEmitter.dispose();
  }

  private async confirmCheckout(pull: PullRequestSummary, repository: GitRepository): Promise<boolean> {
    const current = repository.state.HEAD?.name ?? repository.state.HEAD?.commit?.slice(0, 7) ?? 'your current branch';
    const choice = await vscode.window.showWarningMessage(
      `Check out #${String(pull.number)} “${pull.title}” (commit ${pull.headSha.slice(0, 7)}) in this workspace? ` +
        `You are on ${current}; Finish Pull Request Review returns you there.`,
      { modal: true },
      'Check Out and Review',
    );
    return choice === 'Check Out and Review';
  }

  private async offerReview(): Promise<void> {
    const review = this.review;
    if (review === undefined) {
      return;
    }
    await vscode.commands.executeCommand('malt.pullRequest.focus');
    const skipped = review.skipped.length === 0 ? '' : ` ${String(review.skipped.length)} file(s) could not be reviewed (deleted, binary or too large).`;
    const choice = await vscode.window.showInformationMessage(
      `#${String(review.pull.number)} is checked out: ${String(review.blockCount)} changed block(s) in ${String(review.fileCount)} file(s).${skipped}`,
      'Review All…',
    );
    if (choice === 'Review All…') {
      await this.reviewAll();
    }
  }

  private open(review: PullRequestReview): void {
    this.close();
    this.review = review;
    const refresh = (): void => {
      this.updateMessage();
      this.changeEmitter.fire(undefined);
    };
    this.reviewSubscriptions = [review.tree.onDidChangeTreeData(refresh)];
    void vscode.commands.executeCommand('setContext', 'malt.pullRequestActive', true);
    refresh();
  }

  private close(): void {
    vscode.Disposable.from(...this.reviewSubscriptions).dispose();
    this.reviewSubscriptions = [];
    this.review?.dispose();
    this.review = undefined;
    void vscode.commands.executeCommand('setContext', 'malt.pullRequestActive', false);
    this.view.message = '';
    this.changeEmitter.fire(undefined);
  }

  private updateMessage(): void {
    const review = this.review;
    this.view.message = review === undefined
      ? ''
      : `#${String(review.pull.number)} ${review.pull.title} · by ${review.pull.author} · ${String(review.reviewedCount)} of ${String(review.blockCount)} block(s) reviewed`;
  }
}
