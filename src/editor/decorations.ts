/**
 * Outlines each changed block with a box (top/side/bottom borders across whole lines), colored by review state,
 * plus a faint inline status label after the block's first line.
 */
import * as vscode from 'vscode';
import type { HunkStore, TrackedHunk } from '../review/hunkStore';
import { COLOR_IDS, EMOJI, VISUALS, statusLabel, visualFor } from './visuals';
import type { Visual } from './visuals';

type Edge = 'single' | 'top' | 'middle' | 'bottom';

const EDGES: readonly Edge[] = ['single', 'top', 'middle', 'bottom'];
const BORDER_WIDTHS: Readonly<Record<Edge, string>> = {
  single: '1px',
  top: '1px 1px 0 1px',
  middle: '0 1px 0 1px',
  bottom: '0 1px 1px 1px',
};
const LABEL_MAX = 70;

const key = (visual: Visual, edge: Edge): string => `${visual}:${edge}`;

export class HunkDecorations implements vscode.Disposable {
  private readonly types = new Map<string, vscode.TextEditorDecorationType>();
  private readonly labelType = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 2em', color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic' },
  });
  private readonly disposables: vscode.Disposable[] = [];
  private readonly store: HunkStore;

  public constructor(store: HunkStore) {
    this.store = store;
    for (const visual of VISUALS) {
      for (const edge of EDGES) {
        this.types.set(key(visual, edge), this.createType(visual, edge));
      }
    }
    this.disposables.push(
      store.onDidChange(() => {
        this.renderAll();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.renderAll();
      }),
    );
    this.renderAll();
  }

  public renderAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.render(editor);
    }
  }

  public dispose(): void {
    vscode.Disposable.from(...this.disposables, ...this.types.values(), this.labelType).dispose();
  }

  private createType(visual: Visual, edge: Edge): vscode.TextEditorDecorationType {
    const color = new vscode.ThemeColor(COLOR_IDS[visual]);
    return vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      borderColor: color,
      borderStyle: visual === 'pending' || visual === 'error' ? 'dashed' : 'solid',
      borderWidth: BORDER_WIDTHS[edge],
      borderRadius: '2px',
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
  }

  private render(editor: vscode.TextEditor): void {
    const ranges = new Map<string, vscode.Range[]>();
    const labels: vscode.DecorationOptions[] = [];
    const lastLine = editor.document.lineCount - 1;
    for (const tracked of this.store.hunksFor(editor.document.uri)) {
      const state = this.store.state(tracked.id);
      const visual = visualFor(state);
      for (const [edge, range] of outlineRanges(tracked, lastLine)) {
        const list = ranges.get(key(visual, edge)) ?? [];
        list.push(range);
        ranges.set(key(visual, edge), list);
      }
      const label = `${EMOJI[visual]} MALT · ${statusLabel(state)}`;
      const line = Math.min(tracked.hunk.startLine, lastLine);
      labels.push({
        range: new vscode.Range(line, Number.MAX_SAFE_INTEGER, line, Number.MAX_SAFE_INTEGER),
        renderOptions: { after: { contentText: label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX)}…` : label } },
      });
    }
    for (const [typeKey, type] of this.types) {
      editor.setDecorations(type, ranges.get(typeKey) ?? []);
    }
    editor.setDecorations(this.labelType, labels);
  }
}

const outlineRanges = (tracked: TrackedHunk, lastLine: number): [Edge, vscode.Range][] => {
  const start = Math.min(tracked.hunk.startLine, lastLine);
  const end = Math.min(tracked.hunk.endLine, lastLine);
  const lineRange = (line: number): vscode.Range => new vscode.Range(line, 0, line, 0);
  if (start === end) {
    return [['single', lineRange(start)]];
  }
  const result: [Edge, vscode.Range][] = [['top', lineRange(start)], ['bottom', lineRange(end)]];
  if (end - start > 1) {
    result.push(['middle', new vscode.Range(start + 1, 0, end - 1, 0)]);
  }
  return result;
};
