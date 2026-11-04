import { agentModels } from './agentModels';
import { diagramKey, newDiagram } from './diagram';
import type { Diagram, Part, ViewKind } from './diagram';
import type { MapNode, Snapshot } from './graph';

export interface Place { kind: ViewKind; key: string; item: string }
export const home: Place = { kind: 'architecture', key: '', item: '' };
export const location = (d: Diagram, item = ''): Place => ({ kind: d.kind, key: diagramKey(d), item });
const nodePart = (n: MapNode): Part => ({ id: n.id, label: n.label, parent: n.parent, group: n.kind, ref: n.id,
  detail: n.understanding?.confirmed ?? n.understanding?.what ?? n.path, line: n.line });
const roleOf=(n:MapNode):string=>{
  const parts=n.path.split('/').slice(0,-1);
  return n.understanding?.role ?? (parts.length===0?'Project root':parts.join('/'));
};
const roleMap = (s: Snapshot): Diagram => {
  const d = newDiagram('', 'architecture', 'Subsystems and responsibilities', 'roles');
  const roles = new Set<string>();
  for (const n of s.nodes.filter((v) => v.kind === 'file')) {
    const role = roleOf(n);
    if (!roles.has(role)) { roles.add(role); d.items.push({ id: `role:${  role}`, label: role, group: 'Subsystem' }); }
    d.items.push({ ...nodePart(n), parent: `role:${  role}`, group: role });
  }
  const owners = new Map(d.items.map((i) => [i.id,i.parent]));
  const relations = new Set<string>();
  for (const edge of s.edges) {
    const from = owners.get(edge.from), to = owners.get(edge.to);
    if (from !== undefined && to !== undefined && from !== to) {
      const pair = JSON.stringify([from,to]); if (relations.has(pair)) { continue; }
      relations.add(pair); d.links.push({ from,to,label:edge.kind });
    }
  }
  return d;
};
const schema = (diagrams: Diagram[]): Diagram[] => {
  const tables = diagrams.filter((d) => d.kind === 'er' && d.path.endsWith('.sql'));
  if (tables.length < 2) { return []; }
  const merged = newDiagram('','er','Schema across SQL files','schema');
  const seen = new Set<string>();
  for (const d of tables) {
    for (const p of d.items) {
      if (seen.has(p.id)) { return []; } // Multiple migration versions need a developer-selected schema.
      seen.add(p.id); merged.items.push({ ...p, detail: d.path });
    }
    merged.links.push(...d.links);
  }
  return [merged];
};
export const catalog = (s: Snapshot, history?: Diagram): Diagram[] => {
  const tree = newDiagram('','tree','Repository hierarchy');
  tree.items = s.nodes.map(nodePart);
  const architecture = newDiagram('','architecture','Project connections','project');
  architecture.items = tree.items;
  const diagrams = s.diagrams ?? [];
  return [architecture, roleMap(s), tree, ...agentModels(s.nodes), ...schema(diagrams), ...diagrams, ...(history === undefined ? [] : [history])];
};
export const related = (models: Diagram[], diagram: Diagram, part: Part): { model: Diagram; item: Part }[] => {
  if (part.ref === undefined) { return []; }
  return models.filter((d) => d !== diagram).flatMap((model) => {
    const item = model.items.find((i) => i.ref === part.ref);
    return item === undefined ? [] : [{ model, item }];
  });
};
