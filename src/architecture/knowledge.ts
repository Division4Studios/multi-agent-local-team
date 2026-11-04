/** A standards scan and an accepted conversation have separate records. Rescanning cannot erase human intent. */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseModules } from '../shared/protocol';
import type { ArchitectureDocument, ArchitectureModule } from '../shared/protocol';
import { parseUnderstanding } from '../shared/understanding';
import type { Understanding } from '../shared/understanding';
import { readWorkspaceFile } from '../reviewer/workspace';
import { digest } from './extract';
import type { MapNode, Snapshot } from './graph';
import { mapDirectory, saveMapFile } from './storage';

const scanName = (branch: string): string => `scan-${digest(branch)}.json`;
const noteName = (branch: string, file: MapNode): string => `note-${digest(JSON.stringify([branch, file.path, file.hash]))}.json`;
const read = async (root: string, name: string, limit: number): Promise<unknown> => {
  try {
    const raw = await readWorkspaceFile(root, `${mapDirectory}/${name}`, limit);
    return raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
};
export const saveScan = async (root: string, branch: string, modules: readonly ArchitectureModule[], current: () => boolean): Promise<void> => {
  await saveMapFile(root, scanName(branch), modules.filter((m) => m.understanding !== undefined), current);
};
export const saveNote = async (root: string, target: { branch: string; file: MapNode }, note: Understanding, current: () => boolean): Promise<void> => {
  await saveMapFile(root, noteName(target.branch, target.file), note, current);
};
const withNote = (node: MapNode, knowledge: Understanding | undefined): MapNode => {
  if (knowledge === undefined) {
    return node;
  }
  const tag = knowledge.confirmed === undefined ? 'agent interpretation' : 'developer clarified';
  const unresolved = knowledge.confirmed === undefined && (knowledge.whatEvidence === '' || knowledge.whyEvidence === '');
  return { ...node, tags: [...node.tags, tag, ...(unresolved ? ['needs clarification'] : [])], understanding: knowledge };
};

export const withUnderstanding = async (root: string, snapshot: Snapshot): Promise<Snapshot> => {
  const modules = parseModules(await read(root, scanName(snapshot.branch), 8_000_000)) ?? [];
  const scanned = new Map(modules.map((m) => [m.path, m]));
  const entries = new Set(await readdir(join(root, mapDirectory)).catch((): string[] => []));
  const nodes: MapNode[] = [];
  for (const node of snapshot.nodes) {
    if (node.kind !== 'file') {
      nodes.push(node);
      continue;
    }
    const name = noteName(snapshot.branch, node);
    const note = entries.has(name) ? parseUnderstanding(await read(root, name, 20_000)) : undefined;
    const module = scanned.get(node.path);
    const knowledge = note ?? (module?.fingerprint === node.hash ? module.understanding : undefined);
    nodes.push(withNote(node, knowledge));
  }
  return { ...snapshot, nodes };
};

export const reviewerMap = (snapshot: Snapshot): ArchitectureDocument => {
  const modules: ArchitectureModule[] = [];
  const declarations = new Map<string, string[]>();
  for (const node of snapshot.nodes) {
    if (node.parent === `file:${node.path}`) {
      const names = declarations.get(node.path) ?? [];
      names.push(node.label);
      declarations.set(node.path, names);
    }
  }
  for (const node of snapshot.nodes) {
    if (node.understanding !== undefined) {
      modules.push({ path: node.path, fingerprint: node.hash, purpose: node.understanding.what, exports: declarations.get(node.path) ?? [], understanding: node.understanding });
    }
  }
  return { version: 1, generatedAt: snapshot.generatedAt, modules };
};
