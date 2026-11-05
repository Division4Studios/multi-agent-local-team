import * as vscode from 'vscode';
import { home, location, related } from './catalog';
import type { Place } from './catalog';
import { diagramKey, views, isView } from '../shared/diagram';
import type { Diagram, Part, ViewKind, Wire } from '../shared/diagram';
import type { Atlas } from './navigation';

type RowType = 'folder' | 'view' | 'model' | 'item' | 'jump' | 'page';
export interface AtlasRow {
  type: RowType;
  atlas: Atlas;
  place: Place;
  label: string;
  offset?: number;
  parent?: AtlasRow;
}
const row = (type: RowType, container: Atlas | AtlasRow, place: Place, label: string): AtlasRow =>
  'atlas' in container ? { type, atlas: container.atlas, place, label, parent: container } : { type, atlas: container, place, label };
const nested = (d: Diagram): boolean => d.kind === 'tree' || d.kind === 'architecture' || d.kind === 'waterfall';
const limit = 80;
const viewIcons: Readonly<Record<ViewKind, string>> = {
  architecture: 'organization', workflow: 'git-merge', sequence: 'arrow-swap', dataflow: 'symbol-event',
  lifecycle: 'sync', er: 'database', classes: 'symbol-class', tree: 'list-tree', timeline: 'history', waterfall: 'graph',
};
const rowIcon = (r: AtlasRow): vscode.ThemeIcon => {
  switch (r.type) {
    case 'folder': return new vscode.ThemeIcon('folder');
    case 'jump': return new vscode.ThemeIcon('references');
    case 'page': return new vscode.ThemeIcon('ellipsis');
    case 'item': return new vscode.ThemeIcon('symbol-field');
    case 'model':
    case 'view': return new vscode.ThemeIcon(viewIcons[r.place.kind]);
  }
};

/** State direction in words as well as visually; a return or self-loop must not look like an outgoing call. */
export const relationshipLabel = (wire: Wire, selected: string, peer: Part): string => {
  if (wire.from === wire.to) { return `Self · ${wire.label}`; }
  return `${wire.from === selected ? 'To' : 'From'} ${peer.label} · ${wire.label}`;
};
const children = (d: Diagram, id: string): Part[] =>
  nested(d) ? d.items.filter((i) => (i.parent ?? '') === id) : id === '' ? d.items : [];
const paginate = (items: AtlasRow[], parent: AtlasRow, offset = 0): AtlasRow[] => {
  const page = items.slice(offset, offset + limit);
  if (offset + limit < items.length) {
    page.push({ ...row('page', parent, parent.place, 'More items…'), offset: offset + limit });
  }
  return page;
};
const ancestry = (d: Diagram, item: Part): string[] => {
  const parts = new Map(d.items.map((i) => [i.id, i]));
  const path = new Set([item.id]);
  let parent = nested(d) ? item.parent : undefined;
  while (parent !== undefined && parts.has(parent) && !path.has(parent)) {
    path.add(parent);
    parent = parts.get(parent)?.parent;
  }
  return [...path].reverse();
};
export class AtlasTree implements vscode.TreeDataProvider<AtlasRow>, vscode.Disposable {
  private readonly atlases: Map<string, Atlas>;
  private readonly changed = new vscode.EventEmitter<AtlasRow | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  public readonly tree: vscode.TreeView<AtlasRow>;
  public constructor(atlases: Map<string, Atlas>) {
    this.atlases = atlases;
    this.tree = vscode.window.createTreeView('malt.architectureViews', { treeDataProvider: this, showCollapseAll: true });
  }
  public refresh(): void {
    this.changed.fire(undefined);
  }
  public getParent(r: AtlasRow): AtlasRow | undefined {
    return r.parent;
  }
  public getTreeItem(r: AtlasRow): vscode.TreeItem {
    const leaf = this.getChildren(r).length === 0;
    const t = new vscode.TreeItem(r.label, leaf ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    t.id = JSON.stringify(this.trail(r));
    t.iconPath = rowIcon(r);
    if (r.type !== 'folder' && r.type !== 'page') {
      t.command = {
        command: 'malt.openArchitectureView',
        title: 'Open interactive view',
        arguments: [r.atlas.tracker.folder.uri.toString(), r.place],
      };
    }
    if (r.type === 'view') {
      t.description = views[r.place.kind][1] ?? r.place.kind;
    }
    return t;
  }
  private trail(r: AtlasRow): string[] {
    const parts: string[] = [r.atlas.tracker.folder.uri.toString()];
    let next: AtlasRow | undefined = r;
    while (next !== undefined) {
      parts.push(JSON.stringify([next.type, next.place, next.label, next.offset]));
      next = next.parent;
    }
    return parts;
  }
  public getChildren(parent?: AtlasRow): AtlasRow[] {
    if (parent === undefined) {
      return [...this.atlases.values()].map((a) => row('folder', a, home, a.tracker.folder.name));
    }
    if (parent.type === 'folder') {
      return Object.keys(views)
        .filter(isView)
        .map((kind) => row('view', parent, { kind, key: '', item: '' }, views[kind][0] ?? kind));
    }
    if (parent.type === 'page') {
      let owner = parent.parent;
      while (owner?.type === 'page') {
        owner = owner.parent;
      }
      return owner === undefined ? [] : this.contents(owner, parent.offset).map((child) => ({ ...child, parent }));
    }
    return this.contents(parent, 0);
  }
  private contents(r: AtlasRow, offset = 0): AtlasRow[] {
    const a = r.atlas,
      p = r.place;
    if (r.type === 'view') {
      return paginate(
        a.models.filter((d) => d.kind === p.kind).map((d) => row('model', r, location(d), d.title)),
        r,
        offset,
      );
    }
    const d = a.models.find((m) => diagramKey(m) === p.key);
    if (d === undefined || r.type === 'jump') {
      return [];
    }
    const item = d.items.find((i) => i.id === p.item);
    const parts = children(d, p.item).map((i) => row('item', r, location(d, i.id), i.label));
    if (item !== undefined) {
      for (const w of d.links.filter((l) => l.from === item.id || l.to === item.id)) {
        const peer = d.items.find((i) => i.id === (w.from === item.id ? w.to : w.from));
        if (peer !== undefined) {
          parts.push(row('jump', r, location(d, peer.id), relationshipLabel(w, item.id, peer)));
        }
      }
      for (const x of related(a.models, d, item)) {
        parts.push(row('jump', r, location(x.model, x.item.id), `Open in ${x.model.title}`));
      }
    }
    return paginate(
      [...new Map(parts.map((part) => [JSON.stringify([part.type, part.place, part.label]), part])).values()],
      r,
      offset,
    );
  }
  private findInPages(parent: AtlasRow, match: (r: AtlasRow) => boolean): AtlasRow | undefined {
    let rows = this.getChildren(parent);
    while (rows.length > 0) {
      const found = rows.find(match);
      if (found !== undefined) {
        return found;
      }
      const next = rows.find((r) => r.type === 'page');
      rows = next === undefined ? [] : this.getChildren(next);
    }
    return undefined;
  }
  public async reveal(a: Atlas): Promise<void> {
    const root = row('folder', a, home, a.tracker.folder.name);
    const kind: ViewKind = a.place.kind;
    const mode = row('view', root, { kind, key: '', item: '' }, views[kind][0] ?? kind);
    const d = a.model;
    let target = d === undefined ? mode : (this.findInPages(mode, (r) => r.place.key === diagramKey(d)) ?? mode);
    const item = a.item;
    if (d !== undefined && item !== undefined) {
      for (const id of ancestry(d, item)) {
        target = this.findInPages(target, (r) => r.type === 'item' && r.place.item === id) ?? target;
      }
    }
    await this.tree.reveal(target, { select: true, focus: false, expand: 1 });
  }
  public dispose(): void {
    this.tree.dispose();
    this.changed.dispose();
  }
}
