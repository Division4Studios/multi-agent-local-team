/**
 * Shows where a finding (a standards gap or a consolidation finding) applies: opens the file, finds the named
 * declaration in the real document, outlines it and explains the finding on hover.
 *
 * Findings come from generated files and model output, so they are untrusted: the file must resolve inside the
 * workspace, the location comes from the document itself (language symbols, then a declaration-shaped text search),
 * and hover text is escaped.
 */
import * as vscode from 'vscode';
import { BORDER_WIDTHS, EDGES, outlineRanges } from './decorations';
import type { Edge } from './decorations';
import type { Finding, FindingAnchor } from '../shared/protocol';

const COLOR = new vscode.ThemeColor('malt.finding');

/** A workspace-relative path from untrusted data, or undefined if it could point outside the folder. */
export const workspaceFile = (folder: vscode.WorkspaceFolder, path: string): vscode.Uri | undefined => {
  const segments = path.split(/[\\/]/u);
  const unsafe = path === '' || /^[a-zA-Z]:|^[\\/]/u.test(path) || segments.some((segment) => segment === '..' || segment === '');
  return unsafe ? undefined : vscode.Uri.joinPath(folder.uri, ...segments);
};

const lastSegment = (symbol: string): string => symbol.split(/\.|::/u).at(-1) ?? symbol;

const flatten = (symbols: readonly vscode.DocumentSymbol[]): vscode.DocumentSymbol[] =>
  symbols.flatMap((symbol) => [symbol, ...flatten(symbol.children)]);

/** Language-aware lookup through whatever symbol provider the user has for this file type. */
const fromSymbols = async (uri: vscode.Uri, symbol: string): Promise<vscode.Range | undefined> => {
  const found: unknown = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
  if (!Array.isArray(found)) {
    return undefined;
  }
  const items: readonly unknown[] = found;
  const symbols = items.filter((item): item is vscode.DocumentSymbol => item instanceof vscode.DocumentSymbol);
  const all = flatten(symbols);
  const match = all.find((item) => item.name === symbol) ?? all.find((item) => item.name === lastSegment(symbol));
  return match?.range;
};

const DECLARATION = /\b(?:fn|function|class|struct|enum|trait|interface|type|const|let|var|def|impl|mod|module|export|pub)\b/u;

/** Fallback without a symbol provider: the first line that declares the name, else the first line that uses it. */
export const findDeclarationLine = (text: string, symbol: string): number | undefined => {
  // The name comes from a repository file: escape every regex metacharacter so it can only match literally.
  const escaped = lastSegment(symbol).replace(/[.*+?^${}()|[\]\\/-]/gu, '\\$&');
  const word = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'u');
  const lines = text.split(/\r?\n/u);
  const declaration = lines.findIndex((line) => word.test(line) && DECLARATION.test(line));
  const use = lines.findIndex((line) => word.test(line));
  const line = declaration >= 0 ? declaration : use;
  return line >= 0 ? line : undefined;
};

export const resolveAnchor = async (document: vscode.TextDocument, symbol: string): Promise<vscode.Range | undefined> => {
  const range = await fromSymbols(document.uri, symbol);
  if (range !== undefined) {
    return range;
  }
  const line = findDeclarationLine(document.getText(), symbol);
  return line === undefined ? undefined : document.lineAt(line).range;
};

interface Focus {
  readonly uri: vscode.Uri;
  readonly range: vscode.Range;
  readonly finding: Finding;
  readonly kind: string;
  readonly anchor: FindingAnchor;
}

export class FindingHighlight implements vscode.Disposable, vscode.HoverProvider {
  private readonly types = new Map<Edge, vscode.TextEditorDecorationType>();
  private readonly disposables: vscode.Disposable[] = [];
  private focus: Focus | undefined;

  public constructor() {
    for (const edge of EDGES) {
      this.types.set(edge, vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        borderColor: COLOR,
        borderStyle: 'solid',
        borderWidth: BORDER_WIDTHS[edge],
        backgroundColor: new vscode.ThemeColor('malt.findingBackground'),
        overviewRulerColor: COLOR,
        overviewRulerLane: vscode.OverviewRulerLane.Center,
      }));
    }
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.render();
      }),
      vscode.languages.registerHoverProvider({ scheme: 'file' }, this),
    );
  }

  /** Opens the anchor's file and outlines the declaration. Returns false if it cannot be shown. */
  public async show(folder: vscode.WorkspaceFolder, finding: Finding, anchor: FindingAnchor, kind: string): Promise<boolean> {
    const uri = workspaceFile(folder, anchor.file);
    if (uri === undefined || !finding.files.includes(anchor.file)) {
      return false;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const range = (await resolveAnchor(document, anchor.symbol)) ?? document.lineAt(0).range;
    this.focus = { uri, range, finding, kind, anchor };
    const editor = await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(range.start, range.start) });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.render();
    return true;
  }

  public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const focus = this.focus;
    if (focus?.uri.toString() !== document.uri.toString() || position.line < focus.range.start.line || position.line > focus.range.end.line) {
      return undefined;
    }
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**MALT · ${focus.kind}** — `);
    markdown.appendText(focus.finding.title);
    markdown.appendMarkdown('\n\n');
    markdown.appendText(focus.finding.note);
    markdown.appendMarkdown('\n\n---\n\n');
    markdown.appendText(focus.finding.detail);
    markdown.appendMarkdown('\n\n---\n\n*Declaration:* ');
    markdown.appendText(`${focus.anchor.symbol} · ${focus.finding.files.join(', ')}`);
    return new vscode.Hover(markdown, focus.range);
  }

  public dispose(): void {
    vscode.Disposable.from(...this.disposables, ...this.types.values()).dispose();
  }

  private render(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const focus = this.focus?.uri.toString() === editor.document.uri.toString() ? this.focus : undefined;
      const ranges = new Map<Edge, vscode.Range[]>();
      if (focus !== undefined) {
        for (const [edge, range] of outlineRanges(focus.range.start.line, focus.range.end.line, editor.document.lineCount - 1)) {
          ranges.set(edge, [...(ranges.get(edge) ?? []), range]);
        }
      }
      for (const [edge, type] of this.types) {
        editor.setDecorations(type, ranges.get(edge) ?? []);
      }
    }
  }
}
