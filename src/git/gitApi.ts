/**
 * The subset of VS Code's built-in Git extension API that MALT uses (see vscode/extensions/git/src/api/git.d.ts).
 * Using the built-in extension means MALT never runs git itself.
 */
import * as vscode from 'vscode';

/** Values of the Git extension's `Status` enum that MALT treats specially. */
export const GIT_STATUS = {
  indexDeleted: 2,
  deleted: 6,
  untracked: 7,
  ignored: 8,
  intentToAdd: 9,
};

export interface GitChange {
  readonly uri: vscode.Uri;
  readonly status: number;
}

/**
 * The branch/ref HEAD points at; `commit` is the baseline that `diffWithHEAD` compares against. `name` is the branch
 * name, absent when HEAD is detached.
 */
export interface GitHeadRef {
  readonly commit?: string;
  readonly name?: string;
}

export interface GitRemote {
  readonly name: string;
  readonly fetchUrl?: string;
}

export interface GitRepositoryState {
  readonly HEAD: GitHeadRef | undefined;
  readonly workingTreeChanges: readonly GitChange[];
  readonly indexChanges: readonly GitChange[];
  readonly untrackedChanges?: readonly GitChange[];
  readonly remotes?: readonly GitRemote[];
  readonly onDidChange: vscode.Event<void>;
}

/** Options for `Repository.fetch`: fetches `ref` (a refspec) from `remote`. */
export interface GitFetchOptions {
  readonly remote?: string;
  readonly ref?: string;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
  diffWithHEAD: (path: string) => Promise<string>;
  checkIgnore: (paths: string[]) => Promise<Set<string>>;
  /** Read-only branch tree access for the architecture explorer. */
  getRefs?: (query: { pattern: string }) => Promise<GitHeadRef[]>;
  diffBetweenWithStats?: (from: string, to: string) => Promise<GitChange[]>;
  getObjectDetails?: (ref: string, path: string) => Promise<{ mode: string; size: number }>;
  show?: (ref: string, path: string) => Promise<string>;
  /** Used only to review a pull request (optional so change-tracking fakes need not implement them). */
  fetch?: (options: GitFetchOptions) => Promise<void>;
  checkout?: (treeish: string) => Promise<void>;
  status?: () => Promise<void>;
}

export interface GitApi {
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  getAPI: (version: 1) => GitApi;
}

export const getGitApi = async (): Promise<GitApi | undefined> => {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (extension === undefined) {
    return undefined;
  }
  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports.getAPI(1);
};
