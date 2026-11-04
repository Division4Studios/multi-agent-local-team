/**
 * A standards scan and an accepted conversation have separate records. Rescanning cannot erase human intent.
 *
 * `.malt/` is repository content, so a checked-out repository could plant files there. A note is the only record
 * that attributes intent to the developer, so each one is signed with a per-user key kept in VS Code SecretStorage
 * (never in the workspace) and bound to its branch, path and file hash; a note that fails the check is ignored.
 * Scan records are agent interpretations and never carry confirmed intent.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import { isRecord, isString } from '../shared/guards';
import { parseModules } from '../shared/protocol';
import type { ArchitectureDocument, ArchitectureModule } from '../shared/protocol';
import { parseInterpretation, parseUnderstanding } from '../shared/understanding';
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
const NOTE_KEY_SECRET = 'malt.architecture.noteKey';
const HEX_KEY = /^[0-9a-f]{64}$/u;

/** The note-signing key: created once per user, stored only in SecretStorage (the OS keychain). */
export const loadNoteKey = async (secrets: Pick<vscode.SecretStorage, 'get' | 'store'>): Promise<Buffer> => {
  const saved = await secrets.get(NOTE_KEY_SECRET);
  if (saved !== undefined && HEX_KEY.test(saved)) {
    return Buffer.from(saved, 'hex');
  }
  const key = randomBytes(32);
  await secrets.store(NOTE_KEY_SECRET, key.toString('hex'));
  return key;
};

const signature = (key: Buffer, name: string, note: Understanding): Buffer =>
  createHmac('sha256', key).update(JSON.stringify([name, note])).digest();

const verifiedNote = (key: Buffer, name: string, value: unknown): Understanding | undefined => {
  const note = isRecord(value) ? parseUnderstanding(value['note']) : undefined;
  const mac = isRecord(value) ? value['mac'] : undefined;
  if (note === undefined || !isString(mac) || !HEX_KEY.test(mac)) {
    return undefined;
  }
  return timingSafeEqual(Buffer.from(mac, 'hex'), signature(key, name, note)) ? note : undefined;
};

/** Scan records come from the model: anything claiming developer confirmation is dropped. */
const agentInterpretation = (module: ArchitectureModule | undefined): Understanding | undefined =>
  module?.understanding === undefined ? undefined : parseInterpretation(module.understanding);

export const saveScan = async (root: string, branch: string, modules: readonly ArchitectureModule[], current: () => boolean): Promise<void> => {
  await saveMapFile(root, scanName(branch), modules.filter((m) => m.understanding !== undefined), current);
};
/** Saves a developer clarification, signed with `target.key` and bound to its branch, path and file hash. */
export const saveNote = async (root: string, target: { key: Buffer; branch: string; file: MapNode }, note: Understanding, current: () => boolean): Promise<void> => {
  const name = noteName(target.branch, target.file);
  const normalized = parseUnderstanding(note);
  if (normalized === undefined) {
    throw new Error('The clarification is too long to save.');
  }
  await saveMapFile(root, name, { note: normalized, mac: signature(target.key, name, normalized).toString('hex') }, current);
};
const withNote = (node: MapNode, knowledge: Understanding | undefined): MapNode => {
  if (knowledge === undefined) {
    return node;
  }
  const tag = knowledge.confirmed === undefined ? 'agent interpretation' : 'developer clarified';
  const unresolved = knowledge.confirmed === undefined && (knowledge.whatEvidence === '' || knowledge.whyEvidence === '');
  return { ...node, tags: [...node.tags, tag, ...(unresolved ? ['needs clarification'] : [])], understanding: knowledge };
};

export const withUnderstanding = async (root: string, key: Buffer, snapshot: Snapshot): Promise<Snapshot> => {
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
    const note = entries.has(name) ? verifiedNote(key, name, await read(root, name, 20_000)) : undefined;
    const module = scanned.get(node.path);
    const knowledge = note ?? (module?.fingerprint === node.hash ? agentInterpretation(module) : undefined);
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
