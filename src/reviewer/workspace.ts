/**
 * Read-only access to the reviewed workspace. Every read goes through `readWorkspaceFile`, which confines the
 * file to the workspace by its *real* location: symlinks, junctions and hard links cannot expose files outside it.
 */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ARCHITECTURE_FILE, STANDARDS_FILE, parseArchitectureDocument, parseStandardsDocument } from '../shared/protocol';
import type { ArchitectureDocument, ArchitectureModule, StandardsDocument } from '../shared/protocol';
import { parseInterpretation } from '../shared/understanding';
import { verifyMap } from '../shared/feedSignature';
import { isRecord, isString } from '../shared/guards';

const CONTEXT_LINES = 60;
const MAX_FILE_BYTES = 2_000_000;
const MAX_GENERATED_BYTES = 2_000_000;

/** Read-only; non-blocking where supported so a FIFO planted in the workspace cannot hang the reviewer. */
const OPEN_FLAGS = constants.O_RDONLY | ('O_NONBLOCK' in constants ? constants.O_NONBLOCK : 0);

const isInside = (root: string, target: string): boolean => {
  const fromRoot = relative(root, target);
  return fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot) && !fromRoot.split(sep).includes('..');
};

/** Lexically resolves a workspace-relative path, rejecting anything that escapes the workspace root. */
export const resolveInWorkspace = (root: string, relativePath: string): string => {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, relativePath);
  if (!isInside(absoluteRoot, target)) {
    throw new Error(`Path is outside the workspace: ${relativePath}`);
  }
  return target;
};

/**
 * Verifies, after opening, that the opened file is a single-link regular file whose real path is inside the
 * real workspace root, and that the confined path still refers to that same file (no swap between check and use).
 */
const assertConfined = async (realRoot: string, candidate: string, opened: BigIntStats, label: string): Promise<void> => {
  const resolved = await realpath(candidate);
  if (!isInside(realRoot, resolved)) {
    throw new Error(`Path resolves outside the workspace: ${label}`);
  }
  const current = await stat(resolved, { bigint: true });
  if (current.dev !== opened.dev || current.ino !== opened.ino) {
    throw new Error(`File changed while being read: ${label}`);
  }
  if (!opened.isFile()) {
    throw new Error(`Not a regular file: ${label}`);
  }
  // A hard link's "real path" is inside the workspace even when the same file also lives elsewhere.
  if (opened.nlink > 1n) {
    throw new Error(`Refusing to read a hard-linked file: ${label}`);
  }
};

/**
 * Reads a regular file that really lives inside the workspace. Returns undefined if it is larger than `maxBytes`.
 * Throws if the path, or anything it links to, is outside the workspace.
 */
export const readWorkspaceFile = async (root: string, relativePath: string, maxBytes: number): Promise<string | undefined> => {
  const realRoot = await realpath(root);
  const candidate = resolveInWorkspace(realRoot, relativePath);
  const handle = await open(candidate, OPEN_FLAGS);
  try {
    const opened = await handle.stat({ bigint: true });
    await assertConfined(realRoot, candidate, opened, relativePath);
    return opened.size > BigInt(maxBytes) ? undefined : await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

export interface FileWindow {
  readonly firstLine: number;
  readonly text: string;
}

/** Returns the changed block plus surrounding lines, each prefixed with its 1-based line number. */
export const readFileWindow = async (
  root: string,
  relativePath: string,
  range: { readonly startLine: number; readonly endLine: number },
): Promise<FileWindow> => {
  const content = await readWorkspaceFile(root, relativePath, MAX_FILE_BYTES);
  if (content === undefined) {
    return { firstLine: range.startLine, text: '(file too large to include)' };
  }
  const lines = content.split(/\r?\n/u);
  const first = Math.max(0, range.startLine - CONTEXT_LINES);
  const last = Math.min(lines.length - 1, range.endLine + CONTEXT_LINES);
  const numbered = lines.slice(first, last + 1).map((line, index) => `${String(first + index + 1)}| ${line}`);
  return { firstLine: first, text: numbered.join('\n') };
};

/**
 * Returns a loader for a generated JSON file under `.malt/` (confined like every other read) that re-parses only
 * when the file's text changes. Missing, invalid or unsafe files yield undefined.
 */
const generatedFileLoader = <T>(path: string, parse: (value: unknown) => T | undefined): ((root: string) => Promise<T | undefined>) => {
  let cached: { readonly text: string; readonly value: T | undefined } | undefined;
  return async (root: string): Promise<T | undefined> => {
    try {
      const text = await readWorkspaceFile(root, path, MAX_GENERATED_BYTES);
      if (text !== undefined && cached?.text !== text) {
        cached = { text, value: parse(JSON.parse(text)) };
      }
      return text === undefined ? undefined : cached?.value;
    } catch {
      cached = undefined;
      return undefined;
    }
  };
};

/** `reviewer.json` as written by the extension: the map, and its Ed25519 signature (see `signMap`). */
interface SignedMap {
  readonly data: unknown;
  readonly signature: string;
}
const parseSignedMap = (value: unknown): SignedMap | undefined =>
  isRecord(value) && isString(value['signature']) ? { data: value['data'], signature: value['signature'] } : undefined;

const readStandards = generatedFileLoader(STANDARDS_FILE, parseStandardsDocument);
const readCurrentMap = generatedFileLoader('.malt/maps/v1/reviewer.json', parseSignedMap);
const readArchitecture = generatedFileLoader(ARCHITECTURE_FILE, parseArchitectureDocument);

/** `.malt/standards.json`: documented and inferred rules, and the gaps the last scan found. */
export const loadStandards = async (root: string): Promise<StandardsDocument | undefined> => await readStandards(root);

/** Whether a path names a regular file that really lives inside the workspace, confined exactly like a read. */
const isWorkspaceFile = async (realRoot: string, relativePath: string): Promise<boolean> => {
  try {
    const candidate = resolveInWorkspace(realRoot, relativePath);
    const handle = await open(candidate, OPEN_FLAGS);
    try {
      await assertConfined(realRoot, candidate, await handle.stat({ bigint: true }), relativePath);
      return true;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
};

/** The module with any developer confirmation removed: what is left is an agent interpretation. */
const withoutConfirmation = (module: ArchitectureModule): ArchitectureModule => {
  const understanding = module.understanding === undefined ? undefined : parseInterpretation(module.understanding);
  return {
    path: module.path, purpose: module.purpose, exports: module.exports,
    ...(module.fingerprint === undefined ? {} : { fingerprint: module.fingerprint }),
    ...(understanding === undefined ? {} : { understanding }),
  };
};

/** How many workspace files map validation opens at once, so a large map can't exhaust file descriptors. */
const FILE_CHECK_CONCURRENCY = 16;

/** Maps in order with at most FILE_CHECK_CONCURRENCY calls in flight. */
const mapBounded = async <T, R>(items: readonly T[], map: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += FILE_CHECK_CONCURRENCY) {
    results.push(...(await Promise.all(items.slice(start, start + FILE_CHECK_CONCURRENCY).map(map))));
  }
  return results;
};

const realFiles = async (realRoot: string, modules: readonly ArchitectureModule[]): Promise<ArchitectureModule[]> => {
  const kept = await mapBounded(modules, async (module) => ((await isWorkspaceFile(realRoot, module.path)) ? module : undefined));
  return kept.filter((module): module is ArchitectureModule => module !== undefined);
};

/** The fingerprint MALT gives a file: SHA-256 of its text with CRLF normalized, as the map computes it. */
const fileFingerprint = async (realRoot: string, path: string): Promise<string | undefined> => {
  try {
    const text = await readWorkspaceFile(realRoot, path, MAX_FILE_BYTES);
    return text === undefined ? undefined : createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
  } catch {
    return undefined;
  }
};

/**
 * Entries of the signed branch map must name real workspace files, and a developer confirmation counts only while
 * the file still has the content it was confirmed for; otherwise only the agent interpretation is kept.
 */
const currentModules = async (realRoot: string, modules: readonly ArchitectureModule[]): Promise<ArchitectureModule[]> =>
  await mapBounded(await realFiles(realRoot, modules), async (module) => {
    if (module.understanding?.confirmed === undefined) {
      return module;
    }
    const fingerprint = await fileFingerprint(realRoot, module.path);
    return fingerprint !== undefined && fingerprint === module.fingerprint ? module : withoutConfirmation(module);
  });

/** The signed branch map, only if its signature verifies against the developer's public key. */
const verifiedCurrentMap = async (root: string, verifier: string | undefined): Promise<ArchitectureDocument | undefined> => {
  const signed = await readCurrentMap(root);
  if (verifier === undefined || signed === undefined || !verifyMap(verifier, signed.data, signed.signature)) {
    return undefined;
  }
  return parseArchitectureDocument(signed.data);
};

/** The current branch map wins; committed entries without a fingerprint fill in files it does not describe. */
const mergeMaps = (legacy: readonly ArchitectureModule[], current: ArchitectureDocument): ArchitectureDocument => {
  const previous = new Map(legacy.map((m) => [m.path, m]));
  const modules = new Map(legacy.filter((m) => m.fingerprint === undefined).map((m) => [m.path, m]));
  for (const item of current.modules) {
    const original = previous.get(item.path);
    modules.set(item.path, { ...item, exports: original?.fingerprint === item.fingerprint ? original?.exports ?? [] : item.exports });
  }
  return { ...current, modules: [...modules.values()] };
};

/**
 * The architecture map: the signed branch map (`reviewer.json`) over the committed `.malt/architecture.json`.
 *
 * Both files live in `.malt/`, which a repository can write. The committed map is model output, so its entries
 * never carry developer confirmation. Developer intent comes only from `reviewer.json`, and only when its signature
 * verifies against `verifier` (the public half of the developer's SecretStorage key): an unsigned, forged or
 * unverifiable branch map is ignored. Every entry must name a real file inside the workspace.
 */
export const loadArchitecture = async (root: string, verifier: string | undefined): Promise<ArchitectureDocument> => {
  const realRoot = await realpath(root).catch((): undefined => undefined);
  if (realRoot === undefined) {
    return { version: 1, generatedAt: '', modules: [] };
  }
  const [committed, current] = await Promise.all([readArchitecture(realRoot), verifiedCurrentMap(realRoot, verifier)]);
  const legacy = (await realFiles(realRoot, committed?.modules ?? [])).map(withoutConfirmation);
  return current === undefined
    ? { version: 1, generatedAt: committed?.generatedAt ?? '', modules: legacy }
    : mergeMaps(legacy, { ...current, modules: await currentModules(realRoot, current.modules) });
};
