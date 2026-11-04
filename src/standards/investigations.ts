/**
 * Saved gap investigations (`.malt/investigations.json`, local like the rest of `.malt/`). Keyed by gap id, so an
 * investigation stays with its gap across rescans and is dropped once the gap is gone or its description changes.
 */
import * as vscode from 'vscode';
import { INVESTIGATIONS_FILE, gapId, parseInvestigationsDocument } from '../shared/investigation';
import type { GapInvestigation, InvestigationsDocument } from '../shared/investigation';
import type { Finding } from '../shared/protocol';
import { writeGenerated } from './scanStandards';

export const readInvestigations = async (folder: vscode.WorkspaceFolder): Promise<InvestigationsDocument | undefined> => {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, INVESTIGATIONS_FILE));
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return parseInvestigationsDocument(parsed);
  } catch {
    return undefined;
  }
};

/** Adds or replaces one investigation, keeping only those for gaps the last scan still records. */
export const saveInvestigation = async (folder: vscode.WorkspaceFolder, investigation: GapInvestigation, currentGaps: readonly Finding[]): Promise<void> => {
  const current = new Set(currentGaps.map(gapId));
  const existing = (await readInvestigations(folder))?.investigations ?? [];
  const investigations = [...existing.filter((item) => item.gapId !== investigation.gapId && current.has(item.gapId)), investigation];
  const document: InvestigationsDocument = { version: 1, investigations };
  await writeGenerated(folder, INVESTIGATIONS_FILE, document);
};
