/**
 * "Changes" view in the MALT sidebar: the whole-change consolidation check on top, then changed files → blocks →
 * rule groups → rules. Within a block, groups and rules are sorted running → failed → passed → not run → not
 * applicable. Selecting a checked rule or a finding opens its details.
 */
import * as vscode from 'vscode';
import { posix } from 'node:path';
import type { HunkStore, TrackedHunk } from '../review/hunkStore';
import type { ConsolidationCheck, ConsolidationState } from '../review/consolidation';
import type { Finding } from '../shared/protocol';
import { ruleRows } from '../review/reviewProgress';
import type { RuleRow, RuleRun } from '../review/reviewProgress';
import { buildReviewMarkdown } from '../editor/reviewMarkdown';
import { COLOR_IDS, ICONS, RUN_LABELS, statusLabel, visualFor } from '../editor/visuals';

type Node =
  | { readonly kind: 'consolidation' }
  | { readonly kind: 'finding'; readonly finding: Finding; readonly index: number }
  | { readonly kind: 'file'; readonly hunks: readonly TrackedHunk[] }
  | { readonly kind: 'hunk'; readonly tracked: TrackedHunk }
  | { readonly kind: 'group'; readonly tracked: TrackedHunk; readonly name: string; readonly rows: readonly RuleRow[] }
  | { readonly kind: 'rule'; readonly tracked: TrackedHunk; readonly row: RuleRow };

const RUN_ICONS: Readonly<Record<RuleRun, vscode.ThemeIcon>> = {
  running: new vscode.ThemeIcon('sync~spin'),
  fail: new vscode.ThemeIcon(ICONS.fail, new vscode.ThemeColor(COLOR_IDS.fail)),
  pass: new vscode.ThemeIcon(ICONS.pass, new vscode.ThemeColor(COLOR_IDS.pass)),
  'not-run': new vscode.ThemeIcon(ICONS.pending),
  'not-applicable': new vscode.ThemeIcon('dash'),
};

/** Review identity is content-based; tree identity must distinguish each occurrence of that content. */
const hunkRowId = (tracked: TrackedHunk): string =>
  JSON.stringify(['hunk', tracked.uri.toString(), tracked.id, tracked.hunk.startLine, tracked.hunk.endLine]);

/** Groups rows by rule category (case-insensitive); rows arrive sorted, so the most urgent group comes first. */
const groupRows = (rows: readonly RuleRow[]): { readonly name: string; readonly rows: RuleRow[] }[] => {
  const groups = new Map<string, { readonly name: string; readonly rows: RuleRow[] }>();
  for (const row of rows) {
    const key = row.rule.category.toLowerCase();
    const group = groups.get(key) ?? { name: row.rule.category, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
};

const countLabel = (rows: readonly RuleRow[]): string => {
  const counts = new Map<RuleRun, number>();
  for (const row of rows) {
    counts.set(row.run, (counts.get(row.run) ?? 0) + 1);
  }
  return [...counts].map(([run, count]) => `${String(count)} ${RUN_LABELS[run]}`).join(' · ');
};

export class ChangesTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<undefined>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly subscription: vscode.Disposable;
  private readonly store: HunkStore;
  private readonly consolidation: ConsolidationCheck;

  public constructor(store: HunkStore, consolidation: ConsolidationCheck) {
    this.store = store;
    this.consolidation = consolidation;
    const refresh = (): void => {
      this.changeEmitter.fire(undefined);
    };
    this.subscription = vscode.Disposable.from(store.onDidChange(refresh), consolidation.onDidChange(refresh));
  }

  public getChildren(node?: Node): Node[] {
    switch (node?.kind) {
      case undefined:
        return this.roots();
      case 'consolidation':
        return this.consolidation.state.findings.map((finding, index) => ({ kind: 'finding', finding, index }));
      case 'file':
        return node.hunks.map((tracked) => ({ kind: 'hunk', tracked }));
      case 'hunk': {
        const { review, running } = this.store.state(node.tracked.id);
        const rows = review === undefined ? [] : ruleRows(review, running);
        return groupRows(rows).map((group) => ({ kind: 'group', tracked: node.tracked, ...group }));
      }
      case 'group':
        return node.rows.map((row) => ({ kind: 'rule', tracked: node.tracked, row }));
      case 'rule':
      case 'finding':
        return [];
    }
  }

  public getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'consolidation':
        return consolidationItem(this.consolidation.state);
      case 'finding':
        return findingItem(node.finding, node.index);
      case 'file':
        return this.fileItem(node.hunks);
      case 'hunk':
        return this.hunkItem(node.tracked);
      case 'group':
        return groupItem(node.tracked, node.name, node.rows);
      case 'rule':
        return ruleItem(node.tracked, node.row);
    }
  }

  /** The consolidation row appears once a check has started; files follow in path order. */
  private roots(): Node[] {
    const files: Node[] = [...this.store.allFiles()]
      .filter((hunks) => hunks.length > 0)
      .sort((a, b) => (a[0]?.relativePath ?? '').localeCompare(b[0]?.relativePath ?? ''))
      .map((hunks) => ({ kind: 'file', hunks }));
    return this.consolidation.state.status === 'idle' ? files : [{ kind: 'consolidation' }, ...files];
  }

  public dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
  }

  private fileItem(hunks: readonly TrackedHunk[]): vscode.TreeItem {
    const first = hunks[0];
    const item = new vscode.TreeItem(first?.uri ?? vscode.Uri.file(''), vscode.TreeItemCollapsibleState.Expanded);
    if (first !== undefined) {
      item.id = first.uri.toString();
      item.iconPath = vscode.ThemeIcon.File;
      const directory = posix.dirname(first.relativePath);
      item.description = directory === '.' ? '' : directory;
    }
    const failing = hunks.filter((tracked) => visualFor(this.store.state(tracked.id)) === 'fail').length;
    item.tooltip = `${String(hunks.length)} changed block(s)${failing > 0 ? `, ${String(failing)} failing` : ''}`;
    return item;
  }

  private hunkItem(tracked: TrackedHunk): vscode.TreeItem {
    const state = this.store.state(tracked.id);
    const visual = visualFor(state);
    const item = new vscode.TreeItem(
      `Lines ${String(tracked.hunk.startLine + 1)}–${String(tracked.hunk.endLine + 1)}`,
      state.review === undefined ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = hunkRowId(tracked);
    item.description = state.review?.overview.summary ?? statusLabel(state);
    item.accessibilityInformation = { label: `${tracked.relativePath}, lines ${String(tracked.hunk.startLine + 1)} to ${String(tracked.hunk.endLine + 1)}, ${statusLabel(state)}` };
    item.iconPath = state.status === 'reviewing' || state.status === 'queued'
      ? new vscode.ThemeIcon('sync~spin')
      : new vscode.ThemeIcon(ICONS[visual], new vscode.ThemeColor(COLOR_IDS[visual]));
    item.tooltip = buildReviewMarkdown(tracked, state);
    item.contextValue = 'malt.hunk';
    item.command = { command: 'malt.revealHunk', title: 'Reveal change', arguments: [tracked.id, tracked.hunk.startLine] };
    return item;
  }
}

const groupItem = (tracked: TrackedHunk, name: string, rows: readonly RuleRow[]): vscode.TreeItem => {
  const urgent = rows.some((row) => row.run === 'running' || row.run === 'fail');
  const item = new vscode.TreeItem(name, urgent ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
  item.id = JSON.stringify([hunkRowId(tracked), 'group', name.toLowerCase()]);
  item.description = countLabel(rows);
  item.iconPath = RUN_ICONS[rows[0]?.run ?? 'not-applicable'];
  return item;
};

const ruleItem = (tracked: TrackedHunk, { rule, run, check }: RuleRow): vscode.TreeItem => {
  const item = new vscode.TreeItem(rule.title);
  item.id = JSON.stringify([hunkRowId(tracked), 'rule', rule.id]);
  item.description = check?.note ?? RUN_LABELS[run];
  item.iconPath = RUN_ICONS[run];
  item.tooltip = `${rule.check}\nSource: ${rule.source}`;
  if (check !== undefined) {
    item.command = { command: 'malt.showRuleCheck', title: 'Show details', arguments: [tracked.id, tracked.hunk.startLine, rule.id] };
  }
  return item;
};

const consolidationDescription = (state: ConsolidationState): string => {
  switch (state.status) {
    case 'running':
      return 'checking the whole change…';
    case 'error':
      return `check failed: ${state.error ?? 'unknown error'}`;
    case 'idle':
    case 'done':
      return `${String(state.findings.length)} finding(s)${state.checkedAt === undefined ? '' : ` · checked ${state.checkedAt.toLocaleTimeString()}`}`;
  }
};

const consolidationIcon = (state: ConsolidationState): vscode.ThemeIcon => {
  if (state.status === 'running') {
    return new vscode.ThemeIcon('sync~spin');
  }
  if (state.status === 'error') {
    return new vscode.ThemeIcon(ICONS.error);
  }
  return state.findings.length === 0 ? RUN_ICONS.pass : RUN_ICONS.fail;
};

const consolidationItem = (state: ConsolidationState): vscode.TreeItem => {
  const item = new vscode.TreeItem(
    'Consolidation',
    state.findings.length === 0 ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded,
  );
  item.id = 'consolidation';
  item.description = consolidationDescription(state);
  item.tooltip = 'New code across the whole change that overlaps with other new code or with existing modules.';
  item.iconPath = consolidationIcon(state);
  item.contextValue = 'malt.consolidation';
  return item;
};

const findingItem = (finding: Finding, index: number): vscode.TreeItem => {
  const item = new vscode.TreeItem(finding.title);
  item.id = JSON.stringify(['finding', index, finding.title]);
  item.description = finding.files.join(', ');
  item.tooltip = finding.note;
  item.iconPath = new vscode.ThemeIcon('git-merge');
  item.command = { command: 'malt.showFinding', title: 'Show details', arguments: [index] };
  return item;
};
