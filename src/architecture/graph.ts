import { codeDiagrams } from './typeDiagrams';
import type { Diagram } from './diagram';
import type { Understanding } from '../shared/understanding';
import { posix } from 'node:path';
import type { FileFacts, Reference, Relation } from './extract';

export const ROOT = 'workspace';
export interface MapNode {
  readonly understanding?: Understanding;
  readonly id: string;
  readonly parent: string;
  readonly label: string;
  readonly kind: string;
  readonly path: string;
  readonly line: number;
  readonly tags: readonly string[];
  readonly hash: string;
}
export interface MapEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: Relation;
  readonly line: number;
}
export interface ArchitectureGraph { readonly diagrams?: Diagram[]; readonly nodes: MapNode[]; readonly edges: MapEdge[] }
export interface Snapshot extends ArchitectureGraph {
  readonly version: 1;
  readonly branch: string;
  readonly commit: string;
  readonly generatedAt: string;
  readonly skipped: number;
}
export type Delta = 'added' | 'removed' | 'changed' | 'same';
export interface MapView {
  readonly nodes: readonly (MapNode & { readonly status: Delta })[];
  readonly edges: readonly (MapEdge & { readonly status: Delta })[];
}

const folderId = (path: string): string => path === '.' ? ROOT : `dir:${path}`;
const fileId = (path: string): string => `file:${path}`;
const symbolId = (path: string, qualified: string): string => JSON.stringify([path, qualified]);
const ownerId = (path: string, qualified: string): string => qualified === '' ? fileId(path) : symbolId(path, qualified);
const edgeId = (edge: MapEdge): string => JSON.stringify([edge.from, edge.kind, edge.to]);

const addTree = (nodes: Map<string, MapNode>, file: FileFacts): void => {
  let dir = posix.dirname(file.path);
  while (dir !== '.' && !nodes.has(folderId(dir))) {
    const parent = posix.dirname(dir);
    nodes.set(folderId(dir), { id: folderId(dir), parent: folderId(parent), label: posix.basename(dir), path: dir, kind: 'folder', line: 0, hash: '', tags: [] });
    dir = parent;
  }
  const id = fileId(file.path);
  nodes.set(id, { id, parent: folderId(posix.dirname(file.path)), label: posix.basename(file.path), path: file.path, kind: 'file', line: 1, hash: file.hash, tags: file.tags });
  for (const symbol of file.symbols) {
    const key = symbolId(file.path, symbol.qualified);
    nodes.set(key, { id: key, parent: ownerId(file.path, symbol.parent), label: symbol.name, kind: symbol.kind, line: symbol.line,
      path: file.path, tags: [...file.tags, symbol.kind], hash: symbol.hash });
  }
};

const pythonModule = (from: string, spec: string, paths: ReadonlySet<string>): string | undefined => {
  const dots = /^\.+/u.exec(spec)?.[0].length ?? 0;
  const module = spec.slice(dots).replaceAll('.', '/');
  const stem = dots === 0 ? module : posix.join(posix.dirname(from), '../'.repeat(dots - 1), module);
  return [`${stem}.py`, `${stem}/__init__.py`].find((path) => paths.has(path));
};
const resolveImport = (from: string, spec: string, paths: ReadonlySet<string>): string | undefined => {
  if (from.endsWith('.py')) {
    return pythonModule(from, spec, paths);
  }
  if (!spec.startsWith('.')) {
    return undefined;
  }
  const base = posix.join(posix.dirname(from), spec);
  const stem = base.replace(/\.(?:[cm]?js|jsx)$/u, '');
  const candidates = [base, ...['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs', 'vue', 'svelte'].flatMap((ext) => [`${stem}.${ext}`, `${base}/index.${ext}`])];
  return candidates.find((path) => paths.has(path));
};
interface Index {
  readonly names: Map<string, MapNode[]>;
  readonly byFile: Map<string, Map<string, MapNode[]>>;
  readonly paths: Set<string>;
}
const indexNames = (nodes: Iterable<MapNode>, files: readonly FileFacts[]): Index => {
  const names = new Map<string, MapNode[]>();
  const byFile = new Map<string, Map<string, MapNode[]>>();
  for (const node of nodes) {
    if (node.kind === 'file' || node.kind === 'folder' || node.id === ROOT) {
      continue;
    }
    const local = byFile.get(node.path) ?? new Map<string, MapNode[]>();
    const group = names.get(node.label) ?? [];
    group.push(node);
    names.set(node.label, group);
    const localGroup = local.get(node.label) ?? [];
    localGroup.push(node);
    local.set(node.label, localGroup);
    byFile.set(node.path, local);
  }
  return { names, byFile, paths: new Set(files.map((file) => file.path)) };
};

const unique = (nodes: MapNode[] | undefined): MapNode | undefined => nodes?.length === 1 ? nodes[0] : undefined;
const resolveName = (file: FileFacts, ref: Reference, index: Index, bindings: ReadonlyMap<string, MapNode>): MapNode | undefined => {
  const local = index.byFile.get(file.path)?.get(ref.name);
  const scope = ref.owner.split('.').slice(0, -1).join('.');
  const sibling = unique(local?.filter((node) => node.parent === ownerId(file.path, scope)));
  const direct = sibling ?? unique(local) ?? bindings.get(ref.name);
  if (direct !== undefined || ref.relation === 'calls' || ref.relation === 'renders') {
    return direct;
  }
  // Native/C#/Python package layouts need not encode a type name in a relative import.
  // Only infer a base when one declaration in the same language can explain it.
  return unique(index.names.get(ref.name)?.filter((node) => node.tags[0] === file.tags[0]));
};

const relationKind = (file: FileFacts, ref: Reference, target: MapNode): Relation =>
  file.path.endsWith('.cs') && target.kind === 'interface' && ref.relation === 'inherits' ? 'implements' : ref.relation;
const fileEdges = (file: FileFacts, index: Index): MapEdge[] => {
  const edges: MapEdge[] = [];
  const bindings = new Map<string, MapNode>();
  for (const entry of file.imports) {
    const path = resolveImport(file.path, entry.spec, index.paths);
    if (path === undefined) {
      continue;
    }
    if (entry.local === '') {
      edges.push({ from: fileId(file.path), to: fileId(path), kind: 'imports', line: entry.line });
    } else {
      const target = unique(index.byFile.get(path)?.get(entry.original));
      if (target !== undefined) {
        bindings.set(entry.local, target);
      }
    }
  }
  for (const ref of file.refs) {
    const target = resolveName(file, ref, index, bindings);
    if (target !== undefined) {
      const kind = relationKind(file, ref, target);
      edges.push({ from: ownerId(file.path, ref.owner), to: target.id, kind, line: ref.line });
    }
  }
  return edges;
};

export const buildGraph = (files: readonly FileFacts[]): ArchitectureGraph => {
  const nodes = new Map<string, MapNode>();
  nodes.set(ROOT, { id: ROOT, parent: '', label: 'Project', kind: 'project', path: '', line: 0, tags: [], hash: '' });
  for (const file of files) {
    addTree(nodes, file);
  }
  const index = indexNames(nodes.values(), files);
  const edges = new Map<string, MapEdge>();
  const diagrams: Diagram[] = [];
  for (const file of files) {
    const occurrences = fileEdges(file, index);
    diagrams.push(...(file.diagrams ?? codeDiagrams(file,nodes,occurrences,index.names)));
    for (const edge of occurrences) {
      if (!edges.has(edgeId(edge))) {
        edges.set(edgeId(edge), edge);
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], diagrams };
};

const nodeStatus = (node: MapNode, old: MapNode | undefined): Delta => {
  if (old === undefined) {
    return 'added';
  }
  return old.hash !== node.hash || old.kind !== node.kind || JSON.stringify(old.understanding) !== JSON.stringify(node.understanding) ? 'changed' : 'same';
};
const diffNodes = (after: ArchitectureGraph, before?: ArchitectureGraph): Map<string, MapNode & { status: Delta }> => {
  const oldNodes = new Map(before?.nodes.map((node) => [node.id, node]));
  const nodes = new Map<string, MapNode & { status: Delta }>();
  for (const node of after.nodes) {
    const old = oldNodes.get(node.id);
    nodes.set(node.id, { ...node, status: before === undefined ? 'same' : nodeStatus(node, old) });
    oldNodes.delete(node.id);
  }
  for (const node of oldNodes.values()) {
    nodes.set(node.id, { ...node, status: 'removed' });
  }
  return nodes;
};

/** Stable path + qualified declaration identity. Moving a declaration's line alone does not change it. */
export const compareGraphs = (after: ArchitectureGraph, before?: ArchitectureGraph): MapView => {
  const nodes = diffNodes(after, before);
  const oldEdges = new Map(before?.edges.map((edge) => [edgeId(edge), edge]));
  const edges: (MapEdge & { status: Delta })[] = after.edges.map((edge) => ({
    ...edge, status: oldEdges.delete(edgeId(edge)) || before === undefined ? 'same' : 'added',
  }));
  for (const edge of oldEdges.values()) {
    edges.push({ ...edge, status: 'removed' });
  }
  for (const edge of edges.filter((item) => item.status !== 'same')) {
    const source = nodes.get(edge.from);
    if (source?.status === 'same') {
      source.status = 'changed';
    }
  }
  // Bubble changes to folders so a collapsed overview can lead to every changed declaration.
  for (const node of nodes.values()) {
    if (node.status !== 'same') {
      let parent = nodes.get(node.parent);
      while (parent?.status === 'same') {
        parent.status = 'changed';
        parent = nodes.get(parent.parent);
      }
    }
  }
  return { nodes: [...nodes.values()], edges };
};
