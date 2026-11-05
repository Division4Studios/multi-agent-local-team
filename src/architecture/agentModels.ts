import { newDiagram, isView } from '../shared/diagram';
import type { Diagram, Part } from '../shared/diagram';
import type { MapNode } from './graph';
import type { ModelClaim } from '../shared/understanding';

const addParticipant = (diagram: Diagram, node: MapNode, name: string, summary: string | undefined): void => {
  const existing = diagram.items.find((item) => item.id === name);
  const item: Part = existing ?? { id: name, label: name, ref: `concept:${name}`, detail: node.path,
    group: node.understanding?.role ?? 'Agent interpretation' };
  if (summary !== undefined && summary.trim() !== '' && item.summary === undefined) {
    item.summary = summary;
    item.explanationKind = 'AI explanation';
  }
  if (existing === undefined) { diagram.items.push(item); }
};

const addClaim = (models: Map<string, Diagram>, n: MapNode, claim: ModelClaim): void => {
  if (!isView(claim.view)) {
    return;
  }
  const key = JSON.stringify([claim.view, claim.title]);
  const d = models.get(key) ?? newDiagram('', claim.view, claim.title, `agent:${claim.title}`);
  if (d.summary === undefined && claim.summary !== undefined) { d.summary = claim.summary; }
  addParticipant(d, n, claim.from, claim.fromSummary);
  addParticipant(d, n, claim.to, claim.toSummary);
  const kind = claim.evidence === '' ? 'Hypothesis' : 'Matched excerpt';
  d.links.push({ from: claim.from, to: claim.to, label: `${claim.label} · ${kind}`, kind });
  models.set(key, d);
};
export const agentModels = (nodes: readonly MapNode[]): Diagram[] => {
  const models = new Map<string, Diagram>();
  for (const node of nodes) {
    for (const claim of node.understanding?.claims ?? []) {
      addClaim(models, node, claim);
    }
  }
  return [...models.values()];
};
