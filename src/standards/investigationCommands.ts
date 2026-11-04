/**
 * Commands for gap investigations: investigate one gap, investigate every gap not yet investigated (after saying
 * what it will cost), open an investigation, and jump to one piece of evidence in the code. Gap and evidence
 * arguments are indexes, checked against the current saved data.
 */
import * as vscode from 'vscode';
import { isNonNegativeInteger, isRecord } from '../shared/guards';
import { gapId } from '../shared/investigation';
import type { Finding } from '../shared/protocol';
import { describeProfile } from '../shared/reviewProfiles';
import { readSettings } from '../config';
import { showListPage } from '../views/detailPanel';
import type { FindingHighlight } from '../editor/findingHighlight';
import type { ReviewerClient } from '../review/reviewerClient';
import type { StandardsModel } from './standardsModel';
import { investigationPage } from './investigationPage';
import { saveInvestigation } from './investigations';

export interface InvestigationDeps {
  readonly standards: StandardsModel;
  readonly highlight: FindingHighlight;
  /** The running reviewer, starting it if needed; undefined if it could not be started. */
  readonly reviewer: () => Promise<ReviewerClient | undefined>;
}

/** Accepts a gap index (from a command link) or a gap tree node (from its inline action). */
export const gapIndexFrom = (arg: unknown): number | undefined => {
  if (isNonNegativeInteger(arg)) {
    return arg;
  }
  const index = isRecord(arg) ? arg['index'] : undefined;
  return isNonNegativeInteger(index) ? index : undefined;
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs one investigation and saves it. Returns false if it failed (the error has been shown). */
const investigate = async (deps: InvestigationDeps, client: ReviewerClient, gap: Finding): Promise<boolean> => {
  const folder = deps.standards.workspaceFolder;
  if (folder === undefined) {
    return false;
  }
  try {
    const result = await client.investigateGap(gapId(gap));
    // The gaps may have changed while the call ran; only save against the gaps the scan still records.
    if (!deps.standards.gaps.some((current) => gapId(current) === result.gapId)) {
      return false;
    }
    await saveInvestigation(folder, result, deps.standards.gaps);
    await deps.standards.reload();
    return true;
  } catch (error: unknown) {
    void vscode.window.showErrorMessage(`MALT could not investigate “${gap.title}”: ${describeError(error)}`);
    return false;
  }
};

const investigateOne = async (deps: InvestigationDeps, arg: unknown): Promise<void> => {
  const index = gapIndexFrom(arg);
  const gap = index === undefined ? undefined : deps.standards.gaps[index];
  const client = gap === undefined ? undefined : await deps.reviewer();
  if (gap === undefined || client === undefined) {
    return;
  }
  const done = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `MALT: Investigating “${gap.title}” (reading the code)…` },
    async () => await investigate(deps, client, gap),
  );
  const investigation = done ? deps.standards.investigationFor(gap) : undefined;
  if (investigation !== undefined) {
    showListPage(investigationPage(gap, investigation));
  }
};

const investigateAll = async (deps: InvestigationDeps): Promise<void> => {
  const pending = deps.standards.gaps.filter((gap) => deps.standards.investigationFor(gap) === undefined);
  if (pending.length === 0) {
    void vscode.window.showInformationMessage(deps.standards.gaps.length === 0 ? 'MALT has no recorded gaps to investigate.' : 'Every gap has been investigated.');
    return;
  }
  const profile = describeProfile(readSettings().profiles.investigation);
  const choice = await vscode.window.showWarningMessage(
    `Investigate ${String(pending.length)} gap(s)? Each reads the related code in one call (${profile}).`,
    { modal: true },
    'Investigate',
  );
  const client = choice === 'Investigate' ? await deps.reviewer() : undefined;
  if (client === undefined) {
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'MALT: Investigating gaps', cancellable: true },
    async (progress, token) => {
      for (const [position, gap] of pending.entries()) {
        if (token.isCancellationRequested) {
          return;
        }
        progress.report({ message: `${String(position + 1)} of ${String(pending.length)}: ${gap.title}`, increment: 100 / pending.length });
        await investigate(deps, client, gap);
      }
    },
  );
};

/** Opens a gap's investigation, offering to run one if it has none. */
const showInvestigation = async (deps: InvestigationDeps, arg: unknown): Promise<void> => {
  const index = gapIndexFrom(arg);
  const gap = index === undefined ? undefined : deps.standards.gaps[index];
  if (gap === undefined) {
    return;
  }
  const investigation = deps.standards.investigationFor(gap);
  if (investigation !== undefined) {
    showListPage(investigationPage(gap, investigation));
    return;
  }
  const choice = await vscode.window.showInformationMessage(`“${gap.title}” has not been investigated yet.`, 'Investigate');
  if (choice === 'Investigate') {
    await investigateOne(deps, index);
  }
};

/** Opens the file at one piece of evidence: the quoted lines, outlined, with the observation on hover. */
const showEvidence = async (deps: InvestigationDeps, gapIndex: unknown, evidenceIndex: unknown): Promise<void> => {
  const gap = isNonNegativeInteger(gapIndex) ? deps.standards.gaps[gapIndex] : undefined;
  const investigation = gap === undefined ? undefined : deps.standards.investigationFor(gap);
  const evidence = isNonNegativeInteger(evidenceIndex) ? investigation?.evidence[evidenceIndex] : undefined;
  const folder = deps.standards.workspaceFolder;
  if (gap === undefined || evidence === undefined || folder === undefined) {
    return;
  }
  const finding: Finding = { title: gap.title, files: [evidence.file], note: evidence.observation, detail: evidence.quote, anchors: [] };
  await deps.highlight.show(folder, finding, { file: evidence.file, symbol: evidence.symbol, quote: evidence.quote }, 'Gap evidence');
};

export const registerInvestigationCommands = (
  deps: InvestigationDeps,
  register: (id: string, handler: (...args: unknown[]) => unknown) => vscode.Disposable,
): vscode.Disposable =>
  vscode.Disposable.from(
    register('malt.investigateGap', async (arg: unknown) => {
      await investigateOne(deps, arg);
    }),
    register('malt.investigateAllGaps', async () => {
      await investigateAll(deps);
    }),
    register('malt.showInvestigation', async (arg: unknown) => {
      await showInvestigation(deps, arg);
    }),
    register('malt.showEvidence', async (gapIndex: unknown, evidenceIndex: unknown) => {
      await showEvidence(deps, gapIndex, evidenceIndex);
    }),
  );
