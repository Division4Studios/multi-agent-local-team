/**
 * Read-only access to the reviewed workspace. Every read goes through `readWorkspaceFile`, which confines the
 * file to the workspace by its *real* location: symlinks, junctions and hard links cannot expose files outside it.
 */
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ARCHITECTURE_FILE, STANDARDS_FILE, parseArchitectureDocument, parseStandardsDocument } from '../shared/protocol';
import type { ArchitectureDocument, Rule } from '../shared/protocol';

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
const readArchitecture = generatedFileLoader(ARCHITECTURE_FILE, parseArchitectureDocument);

/** Rules from `.malt/standards.json`. */
export const loadRules = async (root: string): Promise<readonly Rule[]> => (await readStandards(root))?.rules ?? [];

/** The architecture map from `.malt/architecture.json`; empty if there is none. */
export const loadArchitecture = async (root: string): Promise<ArchitectureDocument> =>
  (await readArchitecture(root)) ?? { version: 1, generatedAt: '', modules: [] };
