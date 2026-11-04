/**
 * "Reviewer" view in the MALT sidebar:
 * - Reviewer: one row for health and where it runs; opens the live reviewer log.
 * - Models & effort: the model and effort for each kind of review call; select one to change it.
 * - Standards: opens the standards page; expands into categories → rules.
 * - Gaps: expands into the gaps; each one opens the file at the declaration it names, outlined, with hover details.
 * - Architecture: opens the architecture map page.
 * - Queue: work in progress only (finished blocks drop off).
 * Rescanning is the view's title-bar action, so none of these rows starts a scan by accident.
 */
import * as vscode from 'vscode';
import type { ReviewerManager, ReviewerStatus } from '../backend/reviewerManager';
import type { HunkStore } from '../review/hunkStore';
import type { Finding, FindingAnchor, Rule } from '../shared/protocol';
import { INFERRED_SOURCE_PREFIX } from '../shared/protocol';
import type { RuleGroup, StandardsModel } from '../standards/standardsModel';
import { readSettings } from '../config';
import { REVIEW_TYPES, REVIEW_TYPE_INFO, describeProfile } from '../shared/reviewProfiles';
import type { ReviewType } from '../shared/reviewProfiles';
import { affectsReviewProfiles } from './reviewSettings';

type Node =
  | { readonly kind: 'reviewer' | 'models' | 'standards' | 'gaps' | 'architecture' | 'queue' }
  | { readonly kind: 'reviewType'; readonly type: ReviewType }
  | { readonly kind: 'group'; readonly group: RuleGroup }
  | { readonly kind: 'rule'; readonly rule: Rule }
  | { readonly kind: 'gap'; readonly gap: Finding; readonly index: number }
  | { readonly kind: 'anchor'; readonly anchor: FindingAnchor; readonly gapIndex: number; readonly anchorIndex: number };

const STATE_ICONS: Readonly<Record<ReviewerStatus['state'], vscode.ThemeIcon>> = {
  stopped: new vscode.ThemeIcon('circle-slash'),
  starting: new vscode.ThemeIcon('loading~spin'),
  running: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('malt.hunkPass')),
  unhealthy: new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground')),
  error: new vscode.ThemeIcon('error', new vscode.ThemeColor('malt.hunkFail')),
};

const STATE_WORDS: Readonly<Record<ReviewerStatus['state'], string>> = {
  stopped: 'stopped',
  starting: 'starting',
  running: 'healthy',
  unhealthy: 'not responding',
  error: 'error',
};

const BACKEND_LABELS = { docker: 'Docker container', host: 'local process' };

/** Statuses that mean work is still happening or needs attention; reviewed blocks are done and drop off. */
const ACTIVE_STATUSES = ['reviewing', 'queued', 'pending', 'error'] as const;
const ACTIVE_LABELS: Readonly<Record<(typeof ACTIVE_STATUSES)[number], string>> = {
  reviewing: 'reviewing',
  queued: 'queued',
  pending: 'waiting for reviewer',
  error: 'failed',
};

const plural = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

const scannedDate = (generatedAt: string): string => {
  const date = new Date(generatedAt);
  return Number.isNaN(date.getTime()) ? '' : ` · scanned ${date.toLocaleDateString()}`;
};

const item = (label: string, options: { description?: string; icon: vscode.ThemeIcon; collapsed?: boolean; command?: vscode.Command }): vscode.TreeItem => {
  const state = options.collapsed === undefined
    ? vscode.TreeItemCollapsibleState.None
    : options.collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
  const result = new vscode.TreeItem(label, state);
  result.description = options.description ?? '';
  result.iconPath = options.icon;
  if (options.command !== undefined) {
    result.command = options.command;
  }
  return result;
};

export class ReviewerTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<undefined>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly subscriptions: vscode.Disposable[];
  private readonly manager: ReviewerManager;
  private readonly store: HunkStore;
  private readonly standards: StandardsModel;

  public constructor(manager: ReviewerManager, store: HunkStore, standards: StandardsModel) {
    this.manager = manager;
    this.store = store;
    this.standards = standards;
    const refresh = (): void => {
      this.changeEmitter.fire(undefined);
    };
    this.subscriptions = [
      manager.onDidChangeStatus(refresh),
      store.onDidChange(refresh),
      standards.onDidChange(refresh),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (affectsReviewProfiles(event)) {
          refresh();
        }
      }),
    ];
  }

  /** Only Standards (→ groups → rules) and Gaps (→ gaps → declarations) have children. */
  public getChildren(node?: Node): Node[] {
    if (node === undefined) {
      return [{ kind: 'reviewer' }, { kind: 'models' }, { kind: 'standards' }, { kind: 'gaps' }, { kind: 'architecture' }, { kind: 'queue' }];
    }
    if (node.kind === 'models') {
      return REVIEW_TYPES.map((type) => ({ kind: 'reviewType', type }));
    }
    if (node.kind === 'standards') {
      return this.standards.ruleGroups.map((group) => ({ kind: 'group', group }));
    }
    if (node.kind === 'group') {
      return node.group.rules.map((rule) => ({ kind: 'rule', rule }));
    }
    if (node.kind === 'gaps') {
      return this.standards.gaps.map((gap, index) => ({ kind: 'gap', gap, index }));
    }
    if (node.kind === 'gap' && node.gap.anchors.length > 1) {
      return node.gap.anchors.map((anchor, anchorIndex) => ({ kind: 'anchor', anchor, gapIndex: node.index, anchorIndex }));
    }
    return [];
  }

  public getTreeItem(node: Node): vscode.TreeItem {
    if ('type' in node) {
      return reviewTypeItem(node.type);
    }
    if ('group' in node) {
      return groupItem(node.group);
    }
    if ('rule' in node) {
      return ruleItem(node.rule);
    }
    if ('gap' in node) {
      return gapItem(node.gap, node.index);
    }
    if ('anchor' in node) {
      return anchorItem(node.anchor, node.gapIndex, node.anchorIndex);
    }
    return this.rowItem(node.kind);
  }

  /** The top-level rows. */
  private rowItem(kind: 'reviewer' | 'models' | 'standards' | 'gaps' | 'architecture' | 'queue'): vscode.TreeItem {
    switch (kind) {
      case 'reviewer':
        return this.reviewerItem();
      case 'models':
        return modelsItem();
      case 'standards':
        return this.standardsItem();
      case 'gaps':
        return this.gapsItem();
      case 'architecture':
        return this.architectureItem();
      case 'queue':
        return item('Queue', { description: this.queueSummary(), icon: new vscode.ThemeIcon('list-ordered') });
    }
  }

  public dispose(): void {
    vscode.Disposable.from(...this.subscriptions, this.changeEmitter).dispose();
  }

  private reviewerItem(): vscode.TreeItem {
    const status = this.manager.status;
    const where = status.backend === undefined ? '' : ` · ${BACKEND_LABELS[status.backend]}`;
    const result = item('Reviewer', {
      description: `${STATE_WORDS[status.state]}${where}`,
      icon: STATE_ICONS[status.state],
      command: { command: 'malt.showLiveLog', title: 'Show live reviewer log' },
    });
    const tooltip = new vscode.MarkdownString();
    tooltip.appendText(`Reviewer: ${STATE_WORDS[status.state]}${status.detail === '' ? '' : ` (${status.detail})`}\n`);
    tooltip.appendText(`Runs as: ${status.backend === undefined ? 'not started' : BACKEND_LABELS[status.backend]}\n`);
    tooltip.appendText(`Model provider: ${status.provider ?? 'unknown'}\n\nClick to watch the live reviewer log.`);
    result.tooltip = tooltip;
    return result;
  }

  private standardsItem(): vscode.TreeItem {
    const document = this.standards.standards;
    const groups = this.standards.ruleGroups;
    const result = item('Standards', {
      description: document === undefined ? 'not scanned' : `${plural(document.rules.length, 'rule')} · ${plural(groups.length, 'group')}${scannedDate(document.generatedAt)}`,
      icon: new vscode.ThemeIcon('checklist'),
      command: { command: 'malt.showStandards', title: 'Show project standards' },
      ...(groups.length > 0 ? { collapsed: true } : {}),
    });
    result.tooltip = 'Click to read the project standards, grouped by category. Expand to browse the rules here.';
    return result;
  }

  private gapsItem(): vscode.TreeItem {
    const gaps = this.standards.gaps;
    const result = item('Gaps', {
      description: this.standards.standards === undefined ? 'not scanned' : gaps.length === 0 ? 'none recorded' : `${plural(gaps.length, 'gap')} to decide`,
      icon: new vscode.ThemeIcon('question'),
      ...(gaps.length > 0 ? { collapsed: false } : {}),
    });
    result.tooltip = 'Missing or contradictory standards found by the last scan. Select one to see where it applies.';
    return result;
  }

  private architectureItem(): vscode.TreeItem {
    const map = this.standards.architecture;
    const result = item('Architecture', {
      description: map === undefined ? 'not mapped' : `${plural(map.modules.length, 'file')} mapped${scannedDate(map.generatedAt)}`,
      icon: new vscode.ThemeIcon('type-hierarchy'),
      command: { command: 'malt.showArchitecture', title: 'Show architecture map' },
    });
    result.tooltip = 'Click to read the architecture map: each source file’s purpose and exports, grouped by folder.';
    return result;
  }

  private queueSummary(): string {
    const counts = new Map<string, number>();
    for (const tracked of this.store.allHunks()) {
      const { status } = this.store.state(tracked.id);
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    const parts = ACTIVE_STATUSES
      .filter((status) => (counts.get(status) ?? 0) > 0)
      .map((status) => `${String(counts.get(status) ?? 0)} ${ACTIVE_LABELS[status]}`);
    return parts.length === 0 ? 'idle' : parts.join(' · ');
  }
}

const modelsItem = (): vscode.TreeItem => {
  const { check } = readSettings().profiles;
  const result = item('Models & effort', { description: `rule checks: ${describeProfile(check)}`, icon: new vscode.ThemeIcon('settings-gear'), collapsed: true });
  result.id = 'review-models';
  result.tooltip = 'Which model and how much reasoning effort each kind of review call uses. Expand and select one to change it.';
  return result;
};

const reviewTypeItem = (type: ReviewType): vscode.TreeItem => {
  const info = REVIEW_TYPE_INFO[type];
  const result = item(info.label, {
    description: describeProfile(readSettings().profiles[type]),
    icon: new vscode.ThemeIcon('symbol-method'),
    command: { command: 'malt.configureReviewType', title: 'Change model and effort', arguments: [type] },
  });
  result.id = JSON.stringify(['review-type', type]);
  result.tooltip = `${info.detail} Select to change the model and effort; applies when the reviewer restarts.`;
  return result;
};

const groupItem = (group: RuleGroup): vscode.TreeItem => {
  const result = item(group.name, { description: plural(group.rules.length, 'rule'), icon: new vscode.ThemeIcon('symbol-namespace'), collapsed: true });
  result.id = JSON.stringify(['standards-group', group.name.toLowerCase()]);
  return result;
};

const ruleItem = (rule: Rule): vscode.TreeItem => {
  const inferred = rule.source.startsWith(INFERRED_SOURCE_PREFIX);
  const result = item(rule.title, {
    description: rule.check,
    icon: new vscode.ThemeIcon(inferred ? 'lightbulb' : 'book'),
    command: { command: 'malt.showRule', title: 'Show rule', arguments: [rule.id] },
  });
  result.id = JSON.stringify(['standards-rule', rule.id]);
  result.tooltip = `${rule.check}\n\n${inferred ? 'Inferred from code' : 'Documented'} · ${rule.source}`;
  return result;
};

const gapItem = (gap: Finding, index: number): vscode.TreeItem => {
  const first = gap.anchors[0];
  const result = item(gap.title, {
    description: first === undefined ? gap.files.join(', ') : `${first.symbol} · ${first.file}`,
    icon: new vscode.ThemeIcon(first === undefined ? 'circle-large-outline' : 'go-to-file'),
    command: { command: 'malt.showGap', title: 'Show where this gap applies', arguments: [index, 0] },
    ...(gap.anchors.length > 1 ? { collapsed: true } : {}),
  });
  result.id = JSON.stringify(['gap', index, gap.title]);
  result.contextValue = 'malt.gap';
  const tooltip = new vscode.MarkdownString();
  tooltip.appendText(`${gap.note}\n\n${gap.detail}`);
  result.tooltip = tooltip;
  return result;
};

const anchorItem = (anchor: FindingAnchor, gapIndex: number, anchorIndex: number): vscode.TreeItem => {
  const result = item(anchor.symbol, {
    description: anchor.file,
    icon: new vscode.ThemeIcon('symbol-field'),
    command: { command: 'malt.showGap', title: 'Show where this gap applies', arguments: [gapIndex, anchorIndex] },
  });
  result.id = JSON.stringify(['gap-anchor', gapIndex, anchorIndex, anchor.file, anchor.symbol]);
  return result;
};
