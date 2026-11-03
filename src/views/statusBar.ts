/** Status bar summary: reviewer state and block verdict counts. Clicking opens the MALT sidebar. */
import * as vscode from 'vscode';
import type { ReviewerManager } from '../backend/reviewerManager';
import type { HunkStore } from '../review/hunkStore';
import { visualFor } from '../editor/visuals';
import type { Visual } from '../editor/visuals';

const STATE_ICON = { stopped: '$(circle-slash)', starting: '$(loading~spin)', running: '$(shield)', unhealthy: '$(warning)', error: '$(error)' };

export const createStatusBar = (manager: ReviewerManager, store: HunkStore): vscode.Disposable => {
  const item = vscode.window.createStatusBarItem('malt.status', vscode.StatusBarAlignment.Left, 50);
  item.name = 'MALT';
  item.command = 'workbench.view.extension.malt';
  const update = (): void => {
    const counts: Record<Visual, number> = { pending: 0, pass: 0, fail: 0, error: 0 };
    for (const tracked of store.allHunks()) {
      counts[visualFor(store.state(tracked.id))] += 1;
    }
    const { state, detail } = manager.status;
    item.text = `${STATE_ICON[state]} MALT  $(pass) ${String(counts.pass)}  $(error) ${String(counts.fail)}  $(clock) ${String(counts.pending + counts.error)}`;
    item.tooltip = `MALT reviewer: ${state} (${detail})`;
    item.show();
  };
  update();
  return vscode.Disposable.from(item, manager.onDidChangeStatus(update), store.onDidChange(update));
};
