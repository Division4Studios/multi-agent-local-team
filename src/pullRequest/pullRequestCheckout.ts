/**
 * Checking a pull request out in the workspace, and back again. Uses VS Code's built-in Git extension (MALT never
 * runs git itself). Safety rules:
 * - refuses while there are uncommitted tracked changes, so nothing of the user's can be overwritten;
 * - fetches `refs/pull/<n>/head` and checks out GitHub's exact head commit, then verifies HEAD really is that commit;
 * - remembers the previous branch, and finishing refuses (rather than discarding work) if files were changed on the
 *   PR checkout.
 */
import type { GitRepository } from '../git/gitApi';
import type { GitHubRepo } from '../github/githubApi';
import { parseGitHubRemote } from '../github/githubApi';

export interface GitHubRemote {
  readonly remote: string;
  readonly repo: GitHubRepo;
}

/** Where to find pull requests: an `upstream` remote (fork workflows) first, then `origin`, then any GitHub remote. */
export const findGitHubRemote = (repository: GitRepository): GitHubRemote | undefined => {
  const remotes = (repository.state.remotes ?? []).flatMap((remote) => {
    const repo = remote.fetchUrl === undefined ? undefined : parseGitHubRemote(remote.fetchUrl);
    return repo === undefined ? [] : [{ remote: remote.name, repo }];
  });
  const rank = (name: string): number => (name === 'upstream' ? 0 : name === 'origin' ? 1 : 2);
  return [...remotes].sort((a, b) => rank(a.remote) - rank(b.remote))[0];
};

/** The branch (or, when detached, the commit) to return to when the review finishes. */
export interface PreviousHead {
  readonly treeish: string;
  readonly label: string;
}

export const hasTrackedChanges = (repository: GitRepository): boolean =>
  repository.state.workingTreeChanges.length > 0 || repository.state.indexChanges.length > 0;

const REFRESH_TIMEOUT_MS = 10_000;

/** Waits until the repository reports HEAD at `commit` (the Git extension updates its state asynchronously). */
const waitForHead = async (repository: GitRepository, commit: string): Promise<boolean> => {
  const deadline = Date.now() + REFRESH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await repository.status?.();
    if (repository.state.HEAD?.commit === commit) {
      return true;
    }
    await new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, 200);
    });
  }
  return false;
};

/** Checks out the PR's head commit; returns where to go back to. Throws, changing nothing, if it is not safe. */
export const checkOutPullRequest = async (
  repository: GitRepository,
  remote: string,
  pull: { readonly number: number; readonly headSha: string },
): Promise<PreviousHead> => {
  const { fetch, checkout } = repository;
  if (fetch === undefined || checkout === undefined) {
    throw new Error('This version of the VS Code Git extension cannot fetch or check out.');
  }
  if (hasTrackedChanges(repository)) {
    throw new Error('You have uncommitted changes. Commit or stash them before reviewing a pull request.');
  }
  const head = repository.state.HEAD;
  const previous = head?.name === undefined
    ? head?.commit === undefined ? undefined : { treeish: head.commit, label: head.commit.slice(0, 7) }
    : { treeish: head.name, label: head.name };
  if (previous === undefined) {
    throw new Error('Could not tell which branch you are on.');
  }
  await fetch.call(repository, { remote, ref: `refs/pull/${String(pull.number)}/head` });
  await checkout.call(repository, pull.headSha);
  if (!(await waitForHead(repository, pull.headSha))) {
    throw new Error(`Checked out, but HEAD is not at the pull request's head commit ${pull.headSha.slice(0, 7)}.`);
  }
  return previous;
};

/** Goes back to where the user was. Refuses, keeping their work, if files were changed on the PR checkout. */
export const returnFromPullRequest = async (repository: GitRepository, previous: PreviousHead): Promise<void> => {
  const { checkout } = repository;
  if (checkout === undefined) {
    throw new Error('This version of the VS Code Git extension cannot check out.');
  }
  await repository.status?.();
  if (hasTrackedChanges(repository)) {
    throw new Error(`You changed files on the pull request checkout. Commit or stash them, then finish again to return to ${previous.label}.`);
  }
  await checkout.call(repository, previous.treeish);
};
