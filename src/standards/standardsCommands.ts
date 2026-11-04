/**
 * Commands behind the Reviewer view's Standards, Gaps and Architecture rows. Arguments come from tree items and
 * are checked against the current saved data; nothing a caller passes is trusted as content.
 */
import * as vscode from 'vscode';
import { isNonNegativeInteger, isRecord, isString } from '../shared/guards';
import type { Finding } from '../shared/protocol';
import { showGaps, showListPage } from '../views/detailPanel';
import type { FindingHighlight } from '../editor/findingHighlight';
import type { StandardsModel } from './standardsModel';
import { architecturePage, rulePage, standardsPage } from './standardsPages';

export interface StandardsCommandDeps {
  readonly standards: StandardsModel;
  readonly highlight: FindingHighlight;
  /** Runs Scan Project Standards (used when there is nothing to show yet). */
  readonly scan: () => Promise<void>;
  /** The user opened something to look at: auto-open should leave them alone for a while. */
  readonly onUserFocus: () => void;
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

/** Accepts a gap index (from a command link) or a gap tree node (from its inline action). */
const gapIndexFrom = (arg: unknown): number | undefined => {
  if (isNonNegativeInteger(arg)) {
    return arg;
  }
  const index = isRecord(arg) ? arg['index'] : undefined;
  return isNonNegativeInteger(index) ? index : undefined;
};

/** Every command here opens something for the user, so each one notes their focus first. */
const register = (deps: StandardsCommandDeps, id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable =>
  vscode.commands.registerCommand(id, (...args: unknown[]) => {
    deps.onUserFocus();
    return handler(...args);
  });

export const registerStandardsCommands = (deps: StandardsCommandDeps): vscode.Disposable =>
  vscode.Disposable.from(
    register(deps, 'malt.showStandards', async () => {
      if (deps.standards.standards === undefined) {
        await offerScan(deps, 'project standards');
        return;
      }
      showListPage(standardsPage(deps.standards.standards));
    }),
    register(deps, 'malt.showArchitecture', async () => {
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
          showGaps([gap]);
        });
      }
    }),
    register(deps, 'malt.showGapDetails', (arg: unknown) => {
      const index = gapIndexFrom(arg);
      const gap = index === undefined ? undefined : deps.standards.gaps[index];
      if (gap !== undefined) {
        showGaps([gap]);
      }
    }),
  );
