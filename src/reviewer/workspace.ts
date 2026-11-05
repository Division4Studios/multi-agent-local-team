/**
 * Read-only access to the reviewed workspace. Every read goes through `readWorkspaceFile`, which confines the
 * file to the workspace by its *real* location: symlinks, junctions and hard links cannot expose files outside it.
 */
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ARCHITECTURE_FILE, STANDARDS_FILE, parseArchitectureDocument, parseStandardsDocument } from '../shared/protocol';
import type { ArchitectureDocument, ArchitectureModule, StandardsDocument } from '../shared/protocol';
import { parseInterpretation } from '../shared/understanding';

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

const readStandards = generatedFileLoader(STANDARDS_FILE, parseStandardsDocument);
const readCurrentMap = generatedFileLoader('.malt/maps/v1/reviewer.json', parseArchitectureDocument);
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

/**
 * `.malt/architecture.json` is committed, so a repository controls it. Its entries must name real files inside
 * the workspace, and they never carry developer-confirmed intent: only the extension's signed notes can, and those
 * reach the reviewer through `reviewer.json`.
 */
const committedModules = async (root: string, modules: readonly ArchitectureModule[]): Promise<ArchitectureModule[]> => {
  const realRoot = await realpath(root).catch((): undefined => undefined);
  if (realRoot === undefined) {
    return [];
  }
  const kept = await Promise.all(modules.map(async (module) => ((await isWorkspaceFile(realRoot, module.path)) ? module : undefined)));
  return kept.filter((module): module is ArchitectureModule => module !== undefined).map((module) => {
    const understanding = module.understanding === undefined ? undefined : parseInterpretation(module.understanding);
    return {
      path: module.path, purpose: module.purpose, exports: module.exports,
      ...(module.fingerprint === undefined ? {} : { fingerprint: module.fingerprint }),
      ...(understanding === undefined ? {} : { understanding }),
    };
  });
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

/** The architecture map: the current branch map (`reviewer.json`) over the committed `.malt/architecture.json`. */
export const loadArchitecture = async (root: string): Promise<ArchitectureDocument> => {
  const [committed, current] = await Promise.all([readArchitecture(root), readCurrentMap(root)]);
  const legacy = await committedModules(root, committed?.modules ?? []);
  return current === undefined ? { version: 1, generatedAt: committed?.generatedAt ?? '', modules: legacy } : mergeMaps(legacy, current);
};
