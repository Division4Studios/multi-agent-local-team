/** Pull request fixtures shared by the pull request tests. */
import * as vscode from 'vscode';
import type { PullRequestSummary } from '../../github/githubApi';
import type { TrackedHunk } from '../../review/hunkStore';

export const HEAD_SHA = 'a'.repeat(40);

export const summary = (number: number, headSha: string): PullRequestSummary => ({
  number,
  title: 'Add cards',
  author: 'someone',
  headSha,
  baseRef: 'main',
  headRef: 'cards',
  htmlUrl: `https://github.com/team/app/pull/${String(number)}`,
});

export const tracked = (id: string): TrackedHunk => ({
  id,
  uri: vscode.Uri.file(`/workspace/${id}.ts`),
  relativePath: `${id}.ts`,
  hunk: { header: '@@ -1 +1 @@', body: `+${id}`, startLine: 0, endLine: 0, added: 1, removed: 0 },
});

export const pause = async (): Promise<void> => {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, 50);
  });
};
