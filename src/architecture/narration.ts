/** Explanations describe the evidence visible at this level, without inventing business intent. */
import type { Diagram, Part, ViewKind, Wire } from '../shared/diagram';
import type { SubjectExplanation } from '../shared/understanding';
import type { MapNode, Snapshot } from './graph';

const reading: Readonly<Record<ViewKind, string>> = {
  architecture: 'Each card is a responsibility or building block. Follow the arrows to see which parts depend on one another.',
  sequence: 'Read from top to bottom. Each column is a participant; an arrow is a message or request passed to another participant. Replies point back.',
  dataflow: 'Follow the arrows to see how information moves between the parts that produce, transform and receive it.',
  workflow: 'Follow the connections to see the activities and hand-offs. A branch shows more than one possible next step.',
  lifecycle: 'Each card is a possible state. Arrows show the conditions or actions that move something to another state.',
  classes: 'These are code blueprints and contracts, shown as UML. A class provides behavior; an interface describes a promise other code must fulfil. Arrows show inheritance, ownership or use.',
  er: 'Each card represents stored information. Connections show how records refer to one another; the end labels describe how many can be related.',
  tree: 'This is a containment map. Open a card to see what belongs inside it; Parent returns to the containing level.',
  timeline: 'Read events in time order. Their positions show when they happened, not how long they took.',
  waterfall: 'Each bar is a measured operation. Its position and length show when it started and how long it took.',
};
const cleanLabel = (text: string): string => text.replace(/ · (?:Matched excerpt|Hypothesis)$/u, '');
const isPath = (text: string): boolean => !/\s/u.test(text) && /[/\\]|\.[a-z0-9]{1,8}$|^[a-f\d]{32,64}$/iu.test(text);

interface ExplanationSource { readonly node?: MapNode | undefined; readonly file?: MapNode | undefined; readonly explanation?: SubjectExplanation | undefined }
const qualifiedName = (node: MapNode): string => {
  try {
    const id: unknown = JSON.parse(node.id);
    return Array.isArray(id) && typeof id[1] === 'string' ? id[1] : node.label;
  } catch { return node.label; }
};

/** Repeated method names in one file must not inherit each other's description. */
const declarationExplanation = (node: MapNode, file: MapNode | undefined, snapshot: Snapshot): SubjectExplanation | undefined => {
  if (node.kind === 'file') { return undefined; }
  const explanations = file?.understanding?.explanations ?? [];
  const exact = explanations.find((item) => item.symbol === qualifiedName(node));
  if (exact !== undefined) { return exact; }
  const names = snapshot.nodes.filter((candidate) => candidate.path === node.path && candidate.label === node.label);
  return names.length === 1 ? explanations.find((item) => item.symbol === node.label) : undefined;
};
const explanationSource = (part: Part | undefined, snapshot: Snapshot): ExplanationSource => {
  const node = snapshot.nodes.find((candidate) => candidate.id === part?.ref);
  if (node === undefined) { return {}; }
  const file = snapshot.nodes.find((candidate) => candidate.kind === 'file' && candidate.path === node.path);
  return { node, file, explanation: declarationExplanation(node, file, snapshot) };
};

const typeConnection = (wire: Wire, outgoing: boolean, peer: string): string | undefined => {
  switch (wire.kind ?? wire.label) {
    case 'inherits': case 'inheritance': return outgoing ? `Extends ${peer}, reusing or specializing its behavior.` : `Is extended by ${peer}.`;
    case 'implements': case 'realization': return outgoing ? `Provides the behavior required by ${peer}.` : `Its contract is implemented by ${peer}.`;
    case 'composition': return outgoing ? `Owns ${peer} as part of its structure.` : `Is owned as part of ${peer}.`;
    default: return undefined;
  }
};
const connectionSummary = (diagram: Diagram, wire: Wire, outgoing: boolean): string => {
  const peerId = outgoing ? wire.to : wire.from;
  const peer = diagram.items.find((item) => item.id === peerId)?.label ?? peerId;
  const label = cleanLabel(wire.label);
  const description = label === '' ? 'connection' : label;
  if (diagram.kind === 'classes') {
    const typed = typeConnection(wire, outgoing, peer);
    if (typed !== undefined) { return typed; }
  }
  if (diagram.kind === 'sequence') { return outgoing ? `Sends “${description}” to ${peer}.` : `Receives “${description}” from ${peer}.`; }
  return outgoing ? `Connects to ${peer} through “${description}”.` : `Has a connection from ${peer}: “${description}”.`;
};
const isolatedSummary = (diagram: Diagram, part: Part): string => {
  if (diagram.kind === 'classes') { return part.group === 'interface' ? 'Defines a contract: the behavior other code is expected to provide.' : 'A code blueprint that groups stored information and the actions that work with it.'; }
  if (diagram.kind === 'er') { return `Describes stored records with ${String(part.fields?.length ?? 0)} mapped fields.`; }
  if (diagram.kind === 'waterfall' && part.start !== undefined && part.end !== undefined) {
    return `A measured operation lasting ${String(Math.round((part.end - part.start) * 100) / 100)} milliseconds.`;
  }
  const descriptions: Partial<Record<ViewKind, string>> = {
    timeline: 'A recorded event. Its position shows when it happened.',
    tree: 'An item in the project hierarchy with no nested items recorded.',
    workflow: 'An activity in this workflow. No next step is recorded for it.',
    lifecycle: 'A possible state with no transition recorded at this level.',
    sequence: 'A participant with no messages recorded in this exchange.',
  };
  return descriptions[diagram.kind] ?? 'Its role has not been explained yet. Ask about this item to inspect the available evidence.';
};

export const structuralSummary = (diagram: Diagram, part: Part): string => {
  const incoming = diagram.links.filter((wire) => wire.to === part.id);
  const outgoing = diagram.links.filter((wire) => wire.from === part.id);
  const first = outgoing[0] ?? incoming[0];
  if (first !== undefined) {
    return connectionSummary(diagram, first, outgoing.length > 0);
  }
  const children = diagram.items.filter((item) => item.parent === part.id).length;
  if (children > 0) { return `Groups ${String(children)} parts. Open it to see their responsibilities.`; }
  return isolatedSummary(diagram, part);
};

const fileExplanation = (part: Part, source: ExplanationSource): Part | undefined => {
  const knowledge = source.file?.understanding;
  if (source.node?.kind !== 'file' || knowledge === undefined) { return undefined; }
  if (knowledge.confirmed !== undefined && knowledge.confirmed.trim() !== '') {
    return { ...part, summary: knowledge.confirmed, explanationKind: 'Developer clarification for this file' };
  }
  if (knowledge.what.trim() === '') { return undefined; }
  return { ...part, summary: knowledge.what, explanationKind: knowledge.whatEvidence === '' ? 'Working file explanation' : 'File explanation with source excerpt' };
};

const explainPart = (diagram: Diagram, part: Part, snapshot: Snapshot): Part => {
  if (part.summary !== undefined && part.summary.trim() !== '') { return part; }
  const source = explanationSource(part, snapshot);
  const explanation = source.explanation;
  if (explanation !== undefined) {
    return { ...part, summary: explanation.summary, explanationKind: explanation.evidence === '' ? 'Working explanation' : 'AI explanation with source excerpt' };
  }
  const file = fileExplanation(part, source);
  if (file !== undefined) { return file; }
  if (part.detail !== undefined && part.detail.trim() !== '' && !isPath(part.detail)) { return { ...part, summary: part.detail, explanationKind: 'Recorded explanation' }; }
  return { ...part, summary: structuralSummary(diagram, part), explanationKind: 'Structural description' };
};

export const explainDiagram = (diagram: Diagram, snapshot: Snapshot): Diagram => ({
  ...diagram, items: diagram.items.map((part) => explainPart(diagram, part, snapshot)),
});

export interface ViewNarration { readonly title: string; readonly summary: string; readonly reading: string; readonly scope: string; readonly recommendation: string }
const diagramOverview = (diagram: Diagram): string => {
  const first = diagram.links[0];
  if (first === undefined) { return `This view brings together ${String(diagram.items.length)} parts of ${diagram.title}. No relationships are recorded between them in this view.`; }
  const names = new Map(diagram.items.map((item) => [item.id, item.label]));
  return `This view shows ${String(diagram.items.length)} parts and ${String(diagram.links.length)} connections. For example, ${names.get(first.from) ?? first.from} connects to ${names.get(first.to) ?? first.to}: ${cleanLabel(first.label)}.`;
};
const selectedSummary = (diagram: Diagram, part: Part | undefined): string => part === undefined
  ? diagram.summary ?? diagramOverview(diagram) : part.summary ?? structuralSummary(diagram, part);
const selectedScope = (diagram: Diagram, part: Part | undefined): string => part === undefined
  ? `${diagram.id.startsWith('agent:') ? 'AI interpretation of scanned excerpts' : 'Recorded diagram structure'} · Whole diagram. Select a card to focus the explanation and questions.`
  : `${part.explanationKind ?? 'Recorded explanation'} · Selected item in ${diagram.title}. Questions include its visible connections.`;
export const narrateView = (diagram: Diagram, selected: string, snapshot: Snapshot): ViewNarration => {
  const part = diagram.items.find((item) => item.id === selected);
  const explanation = explanationSource(part, snapshot).explanation;
  return {
    title: part === undefined ? diagram.title : `Understanding ${part.label}`,
    summary: selectedSummary(diagram, part),
    reading: reading[diagram.kind],
    scope: selectedScope(diagram, part),
    recommendation: explanation === undefined ? `Why this view: ${reading[diagram.kind]}` : `AI suggests ${explanation.view}: ${explanation.reason}. This is a presentation recommendation, not additional source evidence.`,
  };
};
