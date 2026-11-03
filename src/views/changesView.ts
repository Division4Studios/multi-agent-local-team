/** "Changes" view in the MALT sidebar: changed files and their reviewed blocks. */
import * as vscode from 'vscode';
import { posix } from 'node:path';
import type { HunkStore, TrackedHunk } from '../review/hunkStore';
import { buildReviewMarkdown } from '../editor/reviewMarkdown';
import { COLOR_IDS, ICONS, statusLabel, visualFor } from '../editor/visuals';

type Node = { readonly kind: 'file'; readonly hunks: readonly TrackedHunk[] } | { readonly kind: 'hunk'; readonly tracked: TrackedHunk };

export class ChangesTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<undefined>();
  public readonly onDidChangeTreeData = this.changeEmitter.event;
  private readonly subscription: vscode.Disposable;
  private readonly store: HunkStore;

  public constructor(store: HunkStore) {
    this.store = store;
    this.subscription = store.onDidChange(() => {
      this.changeEmitter.fire(undefined);
    });
  }

  public getChildren(node?: Node): Node[] {
    if (node === undefined) {
      return [...this.store.allFiles()]
        .filter((hunks) => hunks.length > 0)
        .sort((a, b) => (a[0]?.relativePath ?? '').localeCompare(b[0]?.relativePath ?? ''))
        .map((hunks) => ({ kind: 'file', hunks }));
    }
    return node.kind === 'file' ? node.hunks.map((tracked) => ({ kind: 'hunk', tracked })) : [];
  }

  public getTreeItem(node: Node): vscode.TreeItem {
    return node.kind === 'file' ? this.fileItem(node.hunks) : this.hunkItem(node.tracked);
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
    const item = new vscode.TreeItem(`Lines ${String(tracked.hunk.startLine + 1)}–${String(tracked.hunk.endLine + 1)}`);
    // Review identity is content-based; tree identity must distinguish each occurrence of that content.
    item.id = JSON.stringify(['hunk', tracked.uri.toString(), tracked.id, tracked.hunk.startLine, tracked.hunk.endLine]);
    item.description = state.review?.summary ?? statusLabel(state);
    item.accessibilityInformation = { label: `${tracked.relativePath}, lines ${String(tracked.hunk.startLine + 1)} to ${String(tracked.hunk.endLine + 1)}, ${statusLabel(state)}` };
    item.iconPath = state.status === 'reviewing'
      ? new vscode.ThemeIcon('sync~spin')
      : new vscode.ThemeIcon(ICONS[visual], new vscode.ThemeColor(COLOR_IDS[visual]));
    item.tooltip = buildReviewMarkdown(tracked, state);
    item.contextValue = 'malt.hunk';
    item.command = { command: 'malt.revealHunk', title: 'Reveal change', arguments: [tracked.id, tracked.hunk.startLine] };
    return item;
  }
}
