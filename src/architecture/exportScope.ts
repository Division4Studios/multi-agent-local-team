import { newDiagram } from '../shared/diagram';
import type { Diagram } from '../shared/diagram';
import type { Snapshot } from './graph';

const visibleIds = (s: Snapshot, focus: string): Set<string> => {
  const ids = new Set(s.nodes.filter((n) => n.parent === focus).map((n) => n.id));
  if (ids.size === 0) {
    ids.add(focus);
    for (const e of s.edges) {
      if (e.from === focus || e.to === focus) {
        ids.add(e.from);
        ids.add(e.to);
      }
    }
  }
  return ids;
};
const projectView = (d: Diagram): boolean => d.kind === 'architecture' && d.id === 'project' && d.path === '';
/** Publish the displayed architecture layer. Collapse deeper call/import edges onto their visible ancestors. */
export const exportScope = (s: Snapshot, d: Diagram, selected: string): Diagram => {
  if (!projectView(d)) {
    return d;
  }
  const nodes = new Map(s.nodes.map((n) => [n.id, n]));
  const focus = nodes.get(selected) ?? nodes.get('workspace');
  if (focus === undefined) {
    return d;
  }
  const out = newDiagram('', 'architecture', focus.label, 'project');
  const ids = visibleIds(s, focus.id);
  const ancestor = (id: string): string | undefined => {
    let n = nodes.get(id);
    while (n !== undefined) {
      if (ids.has(n.id)) {
        return n.id;
      }
      n = nodes.get(n.parent);
    }
    return undefined;
  };
  const used = new Set<string>();
  out.items = d.items.filter((i) => ids.has(i.id));
  for (const e of s.edges) {
    const from = ancestor(e.from),
      to = ancestor(e.to);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    const key = JSON.stringify([from, to, e.kind]);
    if (!used.has(key)) {
      used.add(key);
      out.links.push({ from, to, kind: e.kind, label: e.kind });
    }
  }
  return out;
};
