import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readWorkspaceFile } from '../reviewer/workspace';
import { isNonNegativeInteger, isRecord, isString, parseArray, readStrings } from '../shared/guards';
import { digest } from './extract';
import type { MapEdge, MapNode, Snapshot } from './graph';

export const mapDirectory = '.malt/maps/v1';
const key = (kind: 'branch' | 'commit', value: string): string => `${kind}-${digest(value)}.json`;
const createDirectory = async (path: string): Promise<void> => {
  try {
    await mkdir(path);
  } catch (error: unknown) {
    if (!isRecord(error) || error['code'] !== 'EEXIST') {
      throw error;
    }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('The architecture cache must be a directory inside this workspace.');
  }
};

export const saveMapFile = async (root: string, name: string, value: unknown, current: () => boolean): Promise<void> => {
  if (!/^[a-z0-9-]+\.json$/u.test(name)) {
    throw new Error('Invalid map filename');
  }
  let location = root;
  for (const segment of mapDirectory.split('/')) {
    location = join(location, segment);
    await createDirectory(location);
  }
  try {
    await writeFile(join(location, '.gitignore'), '*\n', { flag: 'wx' });
  } catch (error: unknown) {
    if (!isRecord(error) || error['code'] !== 'EEXIST') {
      throw error;
    }
  }
  const target = join(location, name);
  const temp = join(location, `${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  try {
    if (current()) {
      await rename(temp, target);
      return;
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
};

export const saveSnapshot = async (root: string, kind: 'branch' | 'commit', snapshot: Snapshot, current: () => boolean): Promise<void> => {
  await saveMapFile(root, key(kind, kind === 'branch' ? snapshot.branch : snapshot.commit), snapshot, current);
};

const parseNode = (value: unknown): MapNode | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const fields = readStrings(value, ['id', 'parent', 'label', 'kind', 'path', 'hash']);
  const tags = parseArray(value['tags'], (tag) => isString(tag) ? tag : undefined);
  const line = value['line'];
  return fields === undefined || tags === undefined || !isNonNegativeInteger(line) ? undefined : { ...fields, tags, line };
};

const parseEdge = (value: unknown): MapEdge | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const fields = readStrings(value, ['from', 'to']);
  const kind = value['kind'];
  const line = value['line'];
  const valid = kind === 'imports' || kind === 'inherits' || kind === 'implements' || kind === 'calls' || kind === 'renders';
  return fields !== undefined && valid && isNonNegativeInteger(line) ? { ...fields, kind, line } : undefined;
};

export const loadRevision = async (root: string, commit: string): Promise<Snapshot | undefined> => {
  try {
    const raw = await readWorkspaceFile(root, `${mapDirectory}/${key('commit', commit)}`, 64_000_000);
    const value: unknown = JSON.parse(raw ?? '');
    if (!isRecord(value) || value['version'] !== 1 || value['commit'] !== commit) {
      return undefined;
    }
    const fields = readStrings(value, ['branch', 'generatedAt']);
    const skipped = value['skipped'];
    const nodes = parseArray(value['nodes'], parseNode);
    const edges = parseArray(value['edges'], parseEdge);
    return fields !== undefined && isNonNegativeInteger(skipped) && nodes !== undefined && edges !== undefined
      ? { ...fields, version: 1, commit, skipped, nodes, edges } : undefined;
  } catch {
    return undefined;
  }
};
