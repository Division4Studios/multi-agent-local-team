/**
 * "Scan Project Standards": the reviewer reads skills (.claude, .codex), Markdown docs and lint configs and
 * distills short checkable rules, which MALT writes to .malt/standards.json for every later review.
 */
import * as vscode from 'vscode';
import { STANDARDS_FILE } from '../shared/protocol';
import type { StandardsDocument } from '../shared/protocol';
import type { ReviewerClient } from '../review/reviewerClient';

/** Keep generated output local without modifying the project's root ignore policy. */
export const prepareStandardsDirectory = async (folder: vscode.WorkspaceFolder): Promise<void> => {
  const directory = vscode.Uri.joinPath(folder.uri, '.malt');
  await vscode.workspace.fs.createDirectory(directory);
  const ignore = vscode.Uri.joinPath(directory, '.gitignore');
  try {
    await vscode.workspace.fs.stat(ignore);
  } catch (error: unknown) {
    if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') {
      throw error;
    }
    await vscode.workspace.fs.writeFile(ignore, Buffer.from('# Generated MALT output stays local.\n*\n', 'utf8'));
  }
};

export const scanStandards = async (client: ReviewerClient, folder: vscode.WorkspaceFolder): Promise<void> => {
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'MALT: Scanning project standards (skills, docs and configs)…',
    },
    async () => await client.scanStandards(),
  );
  if (result.rules.length === 0) {
    void vscode.window.showInformationMessage(
      result.sources.length === 0
        ? 'MALT found no standards sources (.claude, .codex, Markdown docs or lint configs).'
        : 'MALT did not find any checkable rules in the project sources.',
    );
    return;
  }
  const document: StandardsDocument = { version: 1, generatedAt: new Date().toISOString(), rules: result.rules };
  const target = vscode.Uri.joinPath(folder.uri, STANDARDS_FILE);
  await prepareStandardsDirectory(folder);
  await vscode.workspace.fs.writeFile(target, Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8'));
  const choice = await vscode.window.showInformationMessage(
    `MALT extracted ${String(result.rules.length)} rule(s) from ${String(result.sources.length)} file(s).`,
    'Open Rules',
  );
  if (choice === 'Open Rules') {
    await vscode.window.showTextDocument(target);
  }
};
