/**
 * Commands behind the Reviewer view's Standards, Gaps and Architecture rows. Arguments come from tree items and
 * are checked against the current saved data; nothing a caller passes is trusted as content.
 */
import * as vscode from 'vscode';
import { isNonNegativeInteger, isString } from '../shared/guards';
import type { Finding } from '../shared/protocol';
import { showGaps, showListPage } from '../views/detailPanel';
import type { FindingHighlight } from '../editor/findingHighlight';
import { workspaceFile } from '../editor/findingHighlight';
import { relativePath } from '../architecture/sources';
import type { StandardsModel } from './standardsModel';
import { architecturePage, rulePage, standardsPage } from './standardsPages';
import { gapIndexFrom, registerInvestigationCommands } from './investigationCommands';
import type { ReviewerClient } from '../review/reviewerClient';

export interface StandardsCommandDeps {
  readonly standards: StandardsModel;
  readonly highlight: FindingHighlight;
  /** Runs Scan Project Standards (used when there is nothing to show yet). */
  readonly scan: () => Promise<void>;
  /** The user opened something to look at: auto-open should leave them alone for a while. */
  readonly onUserFocus: () => void;
  /** The running reviewer, starting it if needed (for gap investigations). */
  readonly reviewer: () => Promise<ReviewerClient | undefined>;
}

const offerScan = async (deps: StandardsCommandDeps, what: string): Promise<void> => {
  const choice = await vscode.window.showInformationMessage(`MALT has no ${what} yet. Scan the project now?`, 'Scan Project Standards');
  if (choice === 'Scan Project Standards') {
    await deps.scan();
  }
};

/** Opens a finding where it applies; falls back to its details page when it names no locatable declaration. */
export const showFindingLocation = async (
  highlight: FindingHighlight,
  target: { readonly folder: vscode.WorkspaceFolder | undefined; readonly finding: Finding; readonly kind: string },
  anchorIndex: unknown,
  fallback: () => void,
): Promise<void> => {
  const { folder, finding, kind } = target;
  const anchor = isNonNegativeInteger(anchorIndex) ? finding.anchors[anchorIndex] : undefined;
  const shown = folder !== undefined && anchor !== undefined && (await highlight.show(folder, finding, anchor, kind));
  if (!shown) {
    fallback();
  }
};

/** Every command here opens something for the user, so each one notes their focus first. */
const register = (deps: StandardsCommandDeps, id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable =>
  vscode.commands.registerCommand(id, (...args: unknown[]) => {
    deps.onUserFocus();
    return handler(...args);
  });

const openReference = async (value: unknown): Promise<void> => {
  if (!isString(value)) { return; }
  const target = vscode.Uri.parse(value);
  const folder = vscode.workspace.getWorkspaceFolder(target);
  if (target.scheme !== 'file' || folder === undefined) { return; }
  const uri = await workspaceFile(folder, relativePath(folder.uri, target));
  if (uri === undefined) {
    void vscode.window.showInformationMessage('This reference is no longer available in the workspace.');
    return;
  }
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type === vscode.FileType.Directory) { await vscode.commands.executeCommand('revealInExplorer', uri); }
  else { await vscode.window.showTextDocument(uri, { preview: true }); }
};

export const registerStandardsCommands = (deps: StandardsCommandDeps): vscode.Disposable =>
  vscode.Disposable.from(
    register(deps, 'malt.openFindingReference', openReference),
    register(deps, 'malt.showStandards', async () => {
      if (deps.standards.standards === undefined) {
        await offerScan(deps, 'project standards');
        return;
      }
      showListPage(standardsPage(deps.standards.standards));
    }),
    register(deps, 'malt.showArchitectureSummaries', async () => {
      if (deps.standards.architecture === undefined) {
        await offerScan(deps, 'architecture map');
        return;
      }
      showListPage(architecturePage(deps.standards.architecture));
    }),
    register(deps, 'malt.showRule', (ruleId: unknown) => {
      const rule = isString(ruleId) ? deps.standards.standards?.rules.find((candidate) => candidate.id === ruleId) : undefined;
      if (rule !== undefined) {
        showListPage(rulePage(rule));
      }
    }),
    register(deps, 'malt.showGap', async (index: unknown, anchorIndex: unknown) => {
      const gap = isNonNegativeInteger(index) ? deps.standards.gaps[index] : undefined;
      if (gap !== undefined) {
        const target = { folder: deps.standards.workspaceFolder, finding: gap, kind: 'Standards gap' };
        await showFindingLocation(deps.highlight, target, anchorIndex, () => {
          void showGaps([gap], deps.standards.workspaceFolder);
        });
      }
    }),
    register(deps, 'malt.showGapDetails', (arg: unknown) => {
      const index = gapIndexFrom(arg);
      const gap = index === undefined ? undefined : deps.standards.gaps[index];
      if (gap !== undefined) {
        void showGaps([gap], deps.standards.workspaceFolder);
      }
    }),
    registerInvestigationCommands(
      { standards: deps.standards, highlight: deps.highlight, reviewer: deps.reviewer },
      (id, handler) => register(deps, id, handler),
    ),
  );
