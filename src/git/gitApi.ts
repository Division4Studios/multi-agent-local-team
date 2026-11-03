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

/** The branch/ref HEAD points at; `commit` is the baseline that `diffWithHEAD` compares against. */
export interface GitHeadRef {
  readonly commit?: string;
}

export interface GitRepositoryState {
  readonly HEAD: GitHeadRef | undefined;
  readonly workingTreeChanges: readonly GitChange[];
  readonly indexChanges: readonly GitChange[];
  readonly untrackedChanges?: readonly GitChange[];
  readonly onDidChange: vscode.Event<void>;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: GitRepositoryState;
  diffWithHEAD: (path: string) => Promise<string>;
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
