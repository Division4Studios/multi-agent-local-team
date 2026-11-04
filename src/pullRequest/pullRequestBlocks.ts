/**
 * Turns GitHub's per-file patches for a pull request into the same reviewable blocks MALT uses for local changes.
 * File names come from the PR author, so each must resolve, by real path, inside the workspace folder; anything
 * else is skipped with a reason. Line numbers in GitHub's patches refer to the PR head, which is checked out.
 */
import * as vscode from 'vscode';
import { relative } from 'node:path';
import { hunkId, parseUnifiedDiff } from '../diff/unifiedDiff';
import type { TrackedHunk } from '../review/hunkStore';
import type { PullRequestFile } from '../github/githubApi';
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

const skipReason = (file: PullRequestFile): string | undefined => {
  if (file.status === 'removed') {
    return 'deleted';
  }
  return file.patch === undefined ? 'binary, or too large for GitHub to show a diff' : undefined;
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
    const uri = reason === undefined ? await workspaceFile(folder, relativePath) : undefined;
    if (reason !== undefined || uri === undefined || file.patch === undefined) {
      skipped.push({ file: file.filename, reason: reason ?? 'not a file inside this workspace' });
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
