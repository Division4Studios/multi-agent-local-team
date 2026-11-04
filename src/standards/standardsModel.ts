/**
 * What the last standards scan saved, for the sidebar: rules, gaps and the architecture map, read from
 * `.malt/standards.json` and `.malt/architecture.json` and reloaded whenever a scan rewrites them.
 * The files are generated but live in the repository, so they are untrusted: they go through the protocol
 * parsers, and gap anchors are re-checked with the same policy the reviewer applies.
 */
import * as vscode from 'vscode';
import { loadArchitecture } from '../reviewer/workspace';
import { STANDARDS_FILE, parseStandardsDocument } from '../shared/protocol';
import type { ArchitectureDocument, Finding, Rule, StandardsDocument } from '../shared/protocol';
import { enforceAnchors } from '../reviewer/trust';
import { INVESTIGATIONS_FILE, gapId, parseInvestigationsDocument } from '../shared/investigation';
import type { GapInvestigation } from '../shared/investigation';

export interface RuleGroup {
  readonly name: string;
  readonly rules: readonly Rule[];
}

const readJson = async (uri: vscode.Uri): Promise<unknown> => {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
    return parsed;
  } catch {
    return undefined;
  }
};

/** Groups rules by category (case-insensitive), groups and rules in name order. */
export const groupRules = (rules: readonly Rule[]): RuleGroup[] => {
  const groups = new Map<string, { readonly name: string; readonly rules: Rule[] }>();
  for (const rule of rules) {
    const key = rule.category.toLowerCase();
    const group = groups.get(key) ?? { name: rule.category, rules: [] };
    group.rules.push(rule);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((group) => ({ name: group.name, rules: [...group.rules].sort((a, b) => a.title.localeCompare(b.title)) }));
};

export class StandardsModel implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.changeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly folder: vscode.WorkspaceFolder | undefined;
  private readonly mapVerifier: string | undefined;
  private standardsDocument: StandardsDocument | undefined;
  private architectureDocument: ArchitectureDocument | undefined;
  private investigationsById = new Map<string, GapInvestigation>();

  public constructor(folder: vscode.WorkspaceFolder | undefined, mapVerifier: string | undefined) {
    this.folder = folder;
    this.mapVerifier = mapVerifier;
    if (folder !== undefined) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.malt/{*.json,maps/v1/reviewer.json}'));
      const reload = (): void => {
        void this.reload();
      };
      this.disposables.push(watcher, watcher.onDidChange(reload), watcher.onDidCreate(reload), watcher.onDidDelete(reload));
      reload();
    }
  }

  public get standards(): StandardsDocument | undefined {
    return this.standardsDocument;
  }

  public get architecture(): ArchitectureDocument | undefined {
    return this.architectureDocument;
  }

  public get workspaceFolder(): vscode.WorkspaceFolder | undefined {
    return this.folder;
  }

  public get ruleGroups(): RuleGroup[] {
    return groupRules(this.standardsDocument?.rules ?? []);
  }

  public get gaps(): readonly Finding[] {
    return this.standardsDocument?.gaps ?? [];
  }

  /** The saved investigation of a gap, if it has been investigated since its description last changed. */
  public investigationFor(gap: Finding): GapInvestigation | undefined {
    return this.investigationsById.get(gapId(gap));
  }

  public async reload(): Promise<void> {
    if (this.folder === undefined) {
      return;
    }
    const [standards, architecture, investigations] = await Promise.all([
      readJson(vscode.Uri.joinPath(this.folder.uri, STANDARDS_FILE)),
      loadArchitecture(this.folder.uri.fsPath, this.mapVerifier),
      readJson(vscode.Uri.joinPath(this.folder.uri, INVESTIGATIONS_FILE)),
    ]);
    const saved = parseInvestigationsDocument(investigations)?.investigations ?? [];
    this.investigationsById = new Map(saved.map((investigation) => [investigation.gapId, investigation]));
    const document = parseStandardsDocument(standards);
    this.standardsDocument = document === undefined ? undefined : {
      ...document,
      gaps: document.gaps.map((gap) => ({ ...gap, anchors: enforceAnchors(gap.anchors, new Set(gap.files)) })),
    };
    this.architectureDocument = architecture.modules.length > 0 ? architecture : undefined;
    this.changeEmitter.fire();
  }

  public dispose(): void {
    vscode.Disposable.from(...this.disposables, this.changeEmitter).dispose();
  }
}
