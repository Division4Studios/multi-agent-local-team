import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWorkspaceFile } from '../reviewer/workspace';
import { isRecord, readStrings } from '../shared/guards';
import { signFeed, verifyFeed } from './feedSignature';
import { digest } from './extract';
import { mapDirectory, saveMapFile } from './storage';
import type { Snapshot } from './graph';

export const publishGuidance = async (root: string, s: Snapshot, key: Buffer, live: () => boolean): Promise<void> => {
  const records = s.nodes.flatMap((n) =>
    n.understanding === undefined ? [] : [{ file: n.path, fingerprint: n.hash, understanding: n.understanding }],
  );
  const meta = { branch: s.branch, commit: s.commit, records };
  const data = { version: 1, revision: digest(JSON.stringify(meta)), ...meta };
  await saveMapFile(root, 'guidance.json', { data, signature: signFeed(key, root, data) }, live);
};
const load = async (root: string, name: string, limit: number): Promise<unknown> => {
  const raw = await readWorkspaceFile(root, `${mapDirectory}/${name}`, limit);
  return raw === undefined ? undefined : JSON.parse(raw);
};
export const readGuidance = async (
  root: string,
  verifier: string,
): Promise<{ branch: string; commit: string; revision: string; records: readonly unknown[] }> => {
  const envelope = await load(root, 'guidance.json', 32_000_000);
  if (
    !isRecord(envelope) ||
    typeof envelope['signature'] !== 'string' ||
    !verifyFeed(verifier, root, envelope['data'], envelope['signature'])
  ) {
    throw new Error('The MALT guidance signature does not match this workspace and user.');
  }
  const value = envelope['data'];
  const meta = isRecord(value) ? readStrings(value, ['branch', 'commit', 'revision']) : undefined;
  if (meta === undefined || !isRecord(value) || !Array.isArray(value['records'])) {
    throw new Error('Open this workspace in MALT and wait for architecture indexing.');
  }
  return { ...meta, records: value['records'] };
};
interface Handoff {
  agent: string;
  message: string;
  revision: string;
  id: string;
}
const readNotes = async (root: string, revision: string): Promise<Handoff[]> => {
  const prefix = `handoff-${revision}-`;
  const files = (await readdir(join(root, mapDirectory)))
    .filter((f) => f.startsWith(prefix) && /^handoff-[a-f0-9-]+\.json$/u.test(f))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 100);
  const entries = await Promise.all(
    files.map(async (f) => {
      const v = await load(root, f, 12_000);
      return isRecord(v) ? readStrings(v, ['agent', 'message', 'revision', 'id']) : undefined;
    }),
  );
  return entries.filter((e): e is Handoff => e?.revision === revision);
};
export const guidanceFeed = async (root: string, verifier: string): Promise<{ cursor: string; content: unknown }> => {
  const guidance = await readGuidance(root, verifier);
  const handoffs = await readNotes(root, guidance.revision);
  return { cursor: digest(JSON.stringify([guidance.revision, handoffs.map((e) => e.id)])), content: { ...guidance, handoffs } };
};
export const shareHandoff = async (root: string, verifier: string, input: unknown): Promise<Handoff> => {
  const fields = isRecord(input) ? readStrings(input, ['agent', 'message', 'revision']) : undefined;
  if (fields === undefined || fields.agent.length > 80 || fields.message.length > 2400 || fields.message.trim() === '') {
    throw new Error('Supply agent, message (1–2400 characters) and the current revision.');
  }
  const current = await readGuidance(root, verifier);
  if (current.revision !== fields.revision || !/^[a-f0-9]{64}$/u.test(current.revision)) {
    throw new Error('Guidance changed. Read the current branch and revision first.');
  }
  const id = `${Date.now().toString(16)}-${randomUUID()}`,
    note = { ...fields, id };
  await saveMapFile(root, `handoff-${current.revision}-${id}.json`, note, () => true);
  return note;
};
