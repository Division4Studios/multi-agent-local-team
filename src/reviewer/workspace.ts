/**
 * Read-only access to the reviewed workspace. Every path from a request is resolved and confined to the root.
 */
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { STANDARDS_FILE, parseStandardsDocument } from '../shared/protocol';
import type { Rule } from '../shared/protocol';

const CONTEXT_LINES = 60;
const MAX_FILE_BYTES = 2_000_000;

/** Resolves a workspace-relative path, rejecting anything that escapes the workspace root. */
export const resolveInWorkspace = (root: string, relativePath: string): string => {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, relativePath);
  const fromRoot = relative(absoluteRoot, target);
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot) || fromRoot.split(sep).includes('..')) {
    throw new Error(`Path is outside the workspace: ${relativePath}`);
  }
  return target;
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
  const path = resolveInWorkspace(root, relativePath);
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) {
    return { firstLine: range.startLine, text: '(file unavailable or too large to include)' };
  }
  const lines = (await readFile(path, 'utf8')).split(/\r?\n/u);
  const first = Math.max(0, range.startLine - CONTEXT_LINES);
  const last = Math.min(lines.length - 1, range.endLine + CONTEXT_LINES);
  const numbered = lines.slice(first, last + 1).map((line, index) => `${String(first + index + 1)}| ${line}`);
  return { firstLine: first, text: numbered.join('\n') };
};

interface CachedRules {
  readonly mtimeMs: number;
  readonly rules: readonly Rule[];
}

let rulesCache: CachedRules | undefined;

/** Loads `.malt/standards.json`, re-reading only when it changes. Missing or invalid files yield no rules. */
export const loadRules = async (root: string): Promise<readonly Rule[]> => {
  const path = join(root, STANDARDS_FILE);
  try {
    const info = await stat(path);
    if (rulesCache?.mtimeMs === info.mtimeMs) {
      return rulesCache.rules;
    }
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const rules = parseStandardsDocument(parsed)?.rules ?? [];
    rulesCache = { mtimeMs: info.mtimeMs, rules };
    return rules;
  } catch {
    rulesCache = undefined;
    return [];
  }
};
