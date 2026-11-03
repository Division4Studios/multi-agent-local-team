/** "Reviewer" view in the MALT sidebar: backend health, provider, standards and queue at a glance. */
import * as vscode from 'vscode';
import type { ReviewerManager, ReviewerStatus } from '../backend/reviewerManager';
import type { HunkStore } from '../review/hunkStore';

interface Row {
  readonly label: string;
  readonly description: string;
  readonly icon: vscode.ThemeIcon;
  readonly command?: vscode.Command;
}

const STATE_ICONS: Readonly<Record<ReviewerStatus['state'], vscode.ThemeIcon>> = {
  stopped: new vscode.ThemeIcon('circle-slash'),
  starting: new vscode.ThemeIcon('loading~spin'),
  running: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('malt.hunkPass')),
  unhealthy: new vscode.ThemeIcon('warning', new vscode.ThemeColor('malt.hunkConcerns')),
  error: new vscode.ThemeIcon('error', new vscode.ThemeColor('malt.hunkFail')),
};

const BACKEND_LABELS = { docker: 'Docker container', host: 'Host daemon' };

export class ReviewerTreeProvider implements vscode.TreeDataProvider<Row>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<undefined>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly subscriptions: vscode.Disposable[];
  private readonly manager: ReviewerManager;
  private readonly store: HunkStore;

  public constructor(manager: ReviewerManager, store: HunkStore) {
    this.manager = manager;
    this.store = store;
    const refresh = (): void => {
      this.changeEmitter.fire(undefined);
    };
    this.subscriptions = [manager.onDidChangeStatus(refresh), store.onDidChange(refresh)];
  }

  public getChildren(): Row[] {
    const status = this.manager.status;
    const rows: Row[] = [
      {
        label: 'Reviewer',
        description: `${status.state}${status.detail === '' ? '' : ` · ${status.detail}`}`,
        icon: STATE_ICONS[status.state],
        command: { command: 'malt.showReviewerLogs', title: 'Show logs' },
      },
      {
        label: 'Backend',
        description: status.backend === undefined ? '—' : BACKEND_LABELS[status.backend],
        icon: new vscode.ThemeIcon(status.backend === 'docker' ? 'package' : 'server-process'),
      },
      {
        label: 'Standards',
        description: status.rulesLoaded === undefined ? 'unknown' : `${String(status.rulesLoaded)} project rule(s) + baseline`,
        icon: new vscode.ThemeIcon('checklist'),
        command: { command: 'malt.scanStandards', title: 'Scan project standards' },
      },
      { label: 'Queue', description: this.queueSummary(), icon: new vscode.ThemeIcon('list-ordered') },
    ];
    return rows;
  }

  public getTreeItem(row: Row): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label);
    item.description = row.description;
    item.tooltip = `${row.label}: ${row.description}`;
    item.iconPath = row.icon;
    if (row.command !== undefined) {
      item.command = row.command;
    }
    return item;
  }

  public dispose(): void {
    vscode.Disposable.from(...this.subscriptions, this.changeEmitter).dispose();
  }

  private queueSummary(): string {
    const counts = new Map<string, number>();
    for (const tracked of this.store.allHunks()) {
      const { status } = this.store.state(tracked.id);
      counts.set(status, (counts.get(status) ?? 0) + 1);
    }
    const parts = ['reviewing', 'queued', 'pending', 'reviewed', 'error']
      .filter((status) => (counts.get(status) ?? 0) > 0)
      .map((status) => `${String(counts.get(status) ?? 0)} ${status}`);
    return parts.length === 0 ? 'idle' : parts.join(' · ');
  }
}
