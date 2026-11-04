/**
 * Gap rows in the Reviewer view. A gap shows its investigation verdict once it has one, and expands into a plain-
 * English summary and the evidence (each opens the quoted code). Before it is investigated, a gap with several
 * declarations expands into those declarations. Inline actions: investigate, and the original gap's details.
 */
import * as vscode from 'vscode';
import { posix } from 'node:path';
import type { Finding, FindingAnchor } from '../shared/protocol';
import type { Evidence, GapInvestigation, GapVerdict } from '../shared/investigation';
import { VERDICT_LABELS } from '../shared/investigation';

export type GapNode =
  | { readonly kind: 'gap'; readonly gap: Finding; readonly index: number }
  | { readonly kind: 'anchor'; readonly anchor: FindingAnchor; readonly gapIndex: number; readonly anchorIndex: number }
  | { readonly kind: 'investigation'; readonly gapIndex: number; readonly investigation: GapInvestigation }
  | { readonly kind: 'evidence'; readonly gapIndex: number; readonly evidenceIndex: number; readonly evidence: Evidence };

const GAP_KINDS: ReadonlySet<string> = new Set(['gap', 'anchor', 'investigation', 'evidence']);

export const isGapNode = (node: { readonly kind: string }): node is GapNode => GAP_KINDS.has(node.kind);

const VERDICT_ICONS: Readonly<Record<GapVerdict, vscode.ThemeIcon>> = {
  confirmed: new vscode.ThemeIcon('warning', new vscode.ThemeColor('malt.finding')),
  partly: new vscode.ThemeIcon('question', new vscode.ThemeColor('malt.finding')),
  'not-a-gap': new vscode.ThemeIcon('pass', new vscode.ThemeColor('malt.hunkPass')),
};

/** Investigated: summary then evidence. Not yet: the declarations, when there is more than one. */
export const gapChildren = (gap: Finding, index: number, investigation: GapInvestigation | undefined): GapNode[] => {
  if (investigation !== undefined) {
    return [
      { kind: 'investigation', gapIndex: index, investigation },
      ...investigation.evidence.map((evidence, evidenceIndex): GapNode => ({ kind: 'evidence', gapIndex: index, evidenceIndex, evidence })),
    ];
  }
  return gap.anchors.length > 1 ? gap.anchors.map((anchor, anchorIndex): GapNode => ({ kind: 'anchor', anchor, gapIndex: index, anchorIndex })) : [];
};

const tooltip = (text: string): vscode.MarkdownString => {
  const markdown = new vscode.MarkdownString();
  markdown.appendText(text);
  return markdown;
};

const gapItem = (gap: Finding, index: number, investigation: GapInvestigation | undefined): vscode.TreeItem => {
  const first = gap.anchors[0];
  const expandable = investigation !== undefined || gap.anchors.length > 1;
  const item = new vscode.TreeItem(gap.title, expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  item.id = JSON.stringify(['gap', index, gap.title]);
  item.contextValue = 'malt.gap';
  item.command = { command: 'malt.showGap', title: 'Show where this gap applies', arguments: [index, 0] };
  if (investigation === undefined) {
    item.description = first === undefined ? `${gap.files.join(', ')} · not investigated` : `${first.symbol} · not investigated`;
    item.iconPath = new vscode.ThemeIcon(first === undefined ? 'circle-large-outline' : 'go-to-file');
    item.tooltip = tooltip(`${gap.note}\n\n${gap.detail}\n\nUse the search icon to investigate: MALT reads the real code and decides whether this is an actual gap.`);
  } else {
    item.description = `${VERDICT_LABELS[investigation.verdict]} · ${investigation.confidence} confidence`;
    item.iconPath = VERDICT_ICONS[investigation.verdict];
    item.tooltip = tooltip(`${investigation.plainSummary}\n\nWhy it might not be a gap: ${investigation.counterpoints}`);
  }
  return item;
};

const anchorItem = (anchor: FindingAnchor, gapIndex: number, anchorIndex: number): vscode.TreeItem => {
  const item = new vscode.TreeItem(anchor.symbol);
  item.id = JSON.stringify(['gap-anchor', gapIndex, anchorIndex, anchor.file, anchor.symbol]);
  item.description = anchor.file;
  item.iconPath = new vscode.ThemeIcon('symbol-field');
  item.command = { command: 'malt.showGap', title: 'Show where this gap applies', arguments: [gapIndex, anchorIndex] };
  return item;
};

const investigationItem = (gapIndex: number, investigation: GapInvestigation): vscode.TreeItem => {
  const item = new vscode.TreeItem('In plain English');
  item.id = JSON.stringify(['gap-investigation', gapIndex, investigation.investigatedAt]);
  item.description = investigation.plainSummary;
  item.iconPath = new vscode.ThemeIcon('book');
  item.tooltip = tooltip(`${investigation.plainSummary}\n\nWhat to do: ${investigation.recommendation}`);
  item.command = { command: 'malt.showInvestigation', title: 'Show investigation', arguments: [gapIndex] };
  return item;
};

const evidenceItem = (gapIndex: number, evidenceIndex: number, evidence: Evidence): vscode.TreeItem => {
  const item = new vscode.TreeItem(evidence.symbol === '' ? posix.basename(evidence.file) : evidence.symbol);
  item.id = JSON.stringify(['gap-evidence', gapIndex, evidenceIndex, evidence.file]);
  item.description = `${evidence.file} · ${evidence.observation}`;
  item.iconPath = new vscode.ThemeIcon('quote');
  item.tooltip = tooltip(`${evidence.observation}\n\n${evidence.quote}`);
  item.command = { command: 'malt.showEvidence', title: 'Show this evidence in the code', arguments: [gapIndex, evidenceIndex] };
  return item;
};

export const gapNodeItem = (node: GapNode, investigationFor: (gap: Finding) => GapInvestigation | undefined): vscode.TreeItem => {
  switch (node.kind) {
    case 'gap':
      return gapItem(node.gap, node.index, investigationFor(node.gap));
    case 'anchor':
      return anchorItem(node.anchor, node.gapIndex, node.anchorIndex);
    case 'investigation':
      return investigationItem(node.gapIndex, node.investigation);
    case 'evidence':
      return evidenceItem(node.gapIndex, node.evidenceIndex, node.evidence);
  }
};
