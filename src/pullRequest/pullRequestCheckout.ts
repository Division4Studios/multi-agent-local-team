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

/**
 * Why the workspace no longer holds exactly the PR's files, or undefined while it does. The reviewer reads context
 * from the workspace, so a review must not run against a different commit or edited files.
 */
export const checkoutChange = (repository: GitRepository, headSha: string): string | undefined => {
  if (repository.state.HEAD?.commit !== headSha) {
    return 'the workspace is no longer on the pull request\'s commit';
  }
  return hasTrackedChanges(repository) ? 'files of the pull request checkout were changed' : undefined;
};

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

/**
 * Goes back to where the user was. Refuses, keeping their work, if files were changed on the PR checkout.
 * `beforeLeaving` runs once leaving is certain, just before the checkout (e.g. to let running reviews settle).
 */
export const returnFromPullRequest = async (
  repository: GitRepository,
  previous: PreviousHead,
  beforeLeaving?: () => Promise<void>,
): Promise<void> => {
  const { checkout } = repository;
  if (checkout === undefined) {
    throw new Error('This version of the VS Code Git extension cannot check out.');
  }
  await repository.status?.();
  if (hasTrackedChanges(repository)) {
    throw new Error(`You changed files on the pull request checkout. Commit or stash them, then finish again to return to ${previous.label}.`);
  }
  await beforeLeaving?.();
  await checkout.call(repository, previous.treeish);
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Runs `load` on the fresh PR checkout. If it fails, returns to `previous` before rethrowing, so a failed load
 * (a network error, a PR updated mid-load) never strands the user on a detached PR commit with nothing to finish.
 */
export const returnOnFailure = async <T>(repository: GitRepository, previous: PreviousHead, load: () => Promise<T>): Promise<T> => {
  try {
    return await load();
  } catch (error: unknown) {
    try {
      await returnFromPullRequest(repository, previous);
    } catch (returnError: unknown) {
      throw new Error(`${describeError(error)} MALT could not return you to ${previous.label} (${describeError(returnError)}); check it out yourself.`, { cause: returnError });
    }
    throw new Error(`${describeError(error)} You are back on ${previous.label}.`, { cause: error });
  }
};
