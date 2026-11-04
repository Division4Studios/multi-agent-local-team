/**
 * "Scan Project Standards": the reviewer reads skills (.claude, .codex), Markdown docs and lint configs and
 * distills short checkable rules, which MALT writes to .malt/standards.json for every later review. In parallel it
 * maps the source files (purpose and exports) into .malt/architecture.json, so reviews know what already exists.
 */
import * as vscode from 'vscode';
import { ARCHITECTURE_FILE, STANDARDS_FILE } from '../shared/protocol';
import type { ArchitectureDocument, ArchitectureModule, StandardsDocument } from '../shared/protocol';
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

/** Saves the architecture map; an empty result keeps the previous map. Returns how many files were mapped. */
const saveArchitecture = async (folder: vscode.WorkspaceFolder, result: PromiseSettledResult<readonly ArchitectureModule[]>): Promise<number> => {
  if (result.status === 'rejected') {
    void vscode.window.showErrorMessage(`MALT architecture map failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    return 0;
  }
  if (result.value.length > 0) {
    const document: ArchitectureDocument = { version: 1, generatedAt: new Date().toISOString(), modules: result.value };
    await writeGenerated(folder, ARCHITECTURE_FILE, document);
  }
  return result.value.length;
};

/** Runs the standards scan and the architecture map in parallel; each result is saved independently. */
export const scanStandards = async (client: ReviewerClient, folder: vscode.WorkspaceFolder): Promise<void> => {
  const [standards, architecture] = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'MALT: Scanning project standards (skills, docs and configs) and mapping the code…',
    },
    async () => await Promise.allSettled([client.scanStandards(), client.scanArchitecture()]),
  );
  const mapped = await saveArchitecture(folder, architecture);
  if (standards.status === 'rejected') {
    throw standards.reason;
  }
  const result = standards.value;
  const mappedText = mapped > 0 ? ` Mapped ${String(mapped)} source file(s).` : '';
  if (result.rules.length === 0) {
    void vscode.window.showInformationMessage(
      (result.sources.length === 0
        ? 'MALT found no standards sources (.claude, .codex, Markdown docs or lint configs).'
        : 'MALT did not find any checkable rules in the project sources.') + mappedText,
    );
    return;
  }
  const document: StandardsDocument = { version: 1, generatedAt: new Date().toISOString(), rules: result.rules };
  const target = await writeGenerated(folder, STANDARDS_FILE, document);
  const choice = await vscode.window.showInformationMessage(
    `MALT extracted ${String(result.rules.length)} rule(s) from ${String(result.sources.length)} file(s).${mappedText}`,
    'Open Rules',
  );
  if (choice === 'Open Rules') {
    await vscode.window.showTextDocument(target);
  }
};
