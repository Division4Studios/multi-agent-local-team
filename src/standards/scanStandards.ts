/**
 * "Scan Project Standards": the reviewer reads skills (.claude, .codex), Markdown docs and lint configs and
 * distills short checkable rules, which MALT writes to .malt/standards.json for every later review. In parallel it
 * maps the source files (purpose and exports) into .malt/architecture.json, so reviews know what already exists.
 * A last call compares the two: conventions the code follows that no document states become inferred rules, and
 * what neither settles is recorded as gaps for the team.
 */
import * as vscode from 'vscode';
import { ARCHITECTURE_FILE, INFERRED_SOURCE_PREFIX, STANDARDS_FILE, parseStandardsDocument } from '../shared/protocol';
import type { ArchitectureDocument, StandardsDocument, StandardsScan } from '../shared/protocol';
import { showGaps } from '../views/detailPanel';
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

const writeGenerated = async (folder: vscode.WorkspaceFolder, path: string, document: unknown): Promise<vscode.Uri> => {
  const target = vscode.Uri.joinPath(folder.uri, path);
  await prepareStandardsDirectory(folder);
  await vscode.workspace.fs.writeFile(target, Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8'));
  return target;
};

const countText = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

const summary = (scan: StandardsScan): string => {
  const inferred = scan.rules.filter((rule) => rule.source.startsWith(INFERRED_SOURCE_PREFIX)).length;
  return [
    `MALT read ${countText(scan.sources.length, 'document')} and mapped ${countText(scan.modules.length, 'source file')}:`,
    `${countText(scan.rules.length - inferred, 'documented rule')}, ${countText(inferred, 'rule')} inferred from the code,`,
    `${countText(scan.gaps.length, 'gap')} for the team to decide.`,
  ].join(' ');
};

/**
 * Scans documents and code (one reviewer call that runs both, then a gap analysis) and saves the results. Empty
 * results keep the previous files, so a failed or empty scan never wipes good output.
 */
export const scanStandards = async (client: ReviewerClient, folder: vscode.WorkspaceFolder): Promise<void> => {
  const scan = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'MALT: Scanning standards and architecture docs, mapping the code and looking for gaps…',
    },
    async () => await client.scanStandards(),
  );
  for (const warning of scan.warnings) {
    void vscode.window.showWarningMessage(`MALT: ${warning}`);
  }
  const now = new Date().toISOString();
  if (scan.modules.length > 0) {
    const map: ArchitectureDocument = { version: 1, generatedAt: now, modules: scan.modules };
    await writeGenerated(folder, ARCHITECTURE_FILE, map);
  }
  if (scan.rules.length === 0 && scan.gaps.length === 0) {
    void vscode.window.showInformationMessage(
      scan.sources.length === 0 && scan.modules.length === 0
        ? 'MALT found no standards sources (.claude, .codex, Markdown docs or lint configs) and no source files.'
        : 'MALT did not find any checkable rules or gaps.',
    );
    return;
  }
  const document: StandardsDocument = { version: 1, generatedAt: now, rules: scan.rules, gaps: scan.gaps };
  const target = await writeGenerated(folder, STANDARDS_FILE, document);
  const choice = await vscode.window.showInformationMessage(summary(scan), 'Open Rules', ...(scan.gaps.length > 0 ? ['Show Gaps'] : []));
  if (choice === 'Open Rules') {
    await vscode.window.showTextDocument(target);
  } else if (choice === 'Show Gaps') {
    showGaps(scan.gaps);
  }
};

/** Reopens the gaps the last scan recorded in `.malt/standards.json`. */
export const showSavedGaps = async (folder: vscode.WorkspaceFolder): Promise<void> => {
  let document: StandardsDocument | undefined;
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, STANDARDS_FILE));
    document = parseStandardsDocument(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch {
    document = undefined;
  }
  if (document === undefined || document.gaps.length === 0) {
    void vscode.window.showInformationMessage('MALT has no recorded standards gaps. Run Scan Project Standards to look for them.');
    return;
  }
  showGaps(document.gaps);
};
