/**
 * Turns GitHub's per-file patches for a pull request into the same reviewable blocks MALT uses for local changes.
 * File names come from the PR author, so each must resolve, by real path, inside the workspace folder; anything
 * else is skipped with a reason. Line numbers in GitHub's patches refer to the PR head, which is checked out.
 */
import * as vscode from 'vscode';
import { relative } from 'node:path';
import { hunkId, parseUnifiedDiff } from '../diff/unifiedDiff';
import type { TrackedHunk } from '../review/hunkStore';
import type { PullRequestFile, PullRequestSummary } from '../github/githubApi';
import { workspaceFile } from '../editor/findingHighlight';

/** Enough for a very large PR; beyond this, a PR should be split before review anyway. */
const MAX_BLOCKS = 400;

export interface SkippedFile {
  readonly file: string;
  readonly reason: string;
}

export interface PullRequestBlocks {
  readonly blocks: readonly TrackedHunk[];
  readonly skipped: readonly SkippedFile[];
}

/** The parts of the GitHub client that loading a PR's files needs. */
export interface PullRequestSource {
  pullRequest: (number: number) => Promise<PullRequestSummary>;
  files: (number: number) => Promise<PullRequestFile[]>;
}

/**
 * The PR's files, guaranteed to be GitHub's patches for `headSha` (the checked-out commit). The files endpoint
 * always serves the PR's current head, so the head is read again afterwards: if the author pushed in between, the
 * patches would not match the files on disk, and loading fails instead of mixing the two.
 */
export const filesAtHead = async (source: PullRequestSource, number: number, headSha: string): Promise<PullRequestFile[]> => {
  const files = await source.files(number);
  const now = await source.pullRequest(number);
  if (now.headSha !== headSha) {
    throw new Error(`#${String(number)} was updated while MALT was loading it (head is now ${now.headSha.slice(0, 7)}). Start the review again.`);
  }
  return files;
};

const skipReason = (file: PullRequestFile): string | undefined => {
  if (file.status === 'removed') {
    return 'deleted';
  }
  return file.patch === undefined ? 'binary, or too large for GitHub to show a diff' : undefined;
};

/**
 * The file to outline for a PR path: a regular file inside the workspace, reached without following any link.
 * GitHub's patch for a symlink is the link's target path, not file content, so it is never reviewed (as with local
 * changes): resolving it would outline, and send the reviewer, an unrelated file. `workspaceFile` resolves links
 * anywhere on the path, so a link (to a file, or a folder on the way) shows as a real location other than the path.
 */
const reviewableFile = async (folder: vscode.WorkspaceFolder, relativePath: string): Promise<vscode.Uri | undefined> => {
  const real = await workspaceFile(folder, relativePath);
  if (real?.toString() !== vscode.Uri.joinPath(folder.uri, ...relativePath.split('/')).toString()) {
    return undefined;
  }
  try {
    return (await vscode.workspace.fs.stat(real)).type === vscode.FileType.File ? real : undefined;
  } catch {
    return undefined;
  }
};

export const blocksFromFiles = async (
  folder: vscode.WorkspaceFolder,
  repositoryRoot: vscode.Uri,
  files: readonly PullRequestFile[],
): Promise<PullRequestBlocks> => {
  const blocks: TrackedHunk[] = [];
  const skipped: SkippedFile[] = [];
  for (const file of files) {
    const reason = skipReason(file);
    // GitHub names files relative to the repository root; the reviewer works relative to the workspace folder.
    const inRepository = vscode.Uri.joinPath(repositoryRoot, ...file.filename.split('/'));
    const relativePath = relative(folder.uri.fsPath, inRepository.fsPath).split('\\').join('/');
    const uri = reason === undefined ? await reviewableFile(folder, relativePath) : undefined;
    if (reason !== undefined || uri === undefined || file.patch === undefined) {
      skipped.push({ file: file.filename, reason: reason ?? 'a symlink, or not a file inside this workspace' });
      continue;
    }
    for (const hunk of parseUnifiedDiff(file.patch)) {
      if (blocks.length >= MAX_BLOCKS) {
        skipped.push({ file: file.filename, reason: `over the ${String(MAX_BLOCKS)}-block limit for one review` });
        break;
      }
      blocks.push({ id: hunkId(relativePath, hunk), uri, relativePath, hunk });
    }
  }
  return { blocks, skipped };
};
