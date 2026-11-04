/**
 * Picks the part of the architecture map that matters for a change, so each call gets a few hundred to a few
 * thousand tokens of "what already exists" instead of the whole map. Also pulls the new declarations out of a
 * change for the consolidation check. Pure functions over untrusted data; nothing here reads files.
 */
import { posix } from 'node:path';
import type { ArchitectureModule, ReviewRequest } from '../shared/protocol';

const MAX_DECLARATION_LINES_PER_FILE = 40;
const MAX_DECLARATION_CHARS = 60_000;
const MIN_WORD = 4;
const COMMON_WORDS: ReadonlySet<string> = new Set([
  'const', 'export', 'import', 'from', 'function', 'return', 'async', 'await', 'class', 'interface', 'type', 'string',
  'number', 'boolean', 'readonly', 'public', 'private', 'static', 'void', 'null', 'undefined', 'true', 'false', 'this',
  'value', 'data', 'index', 'default', 'promise', 'error', 'with', 'else', 'self', 'none', 'test', 'tests', 'util', 'utils',
]);
/** An added line that starts a declaration in most mainstream languages. */
const DECLARATION = /^\+\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|abstract\s+|async\s+|pub\s+)*(?:class|interface|type|enum|struct|trait|function|def|fn|func|const|let|var|record|object)\s+\w/u;

/** Lowercase identifier parts (camelCase, snake_case and kebab-case split), without very short or common ones. */
const wordsOf = (text: string): Set<string> => {
  const parts = text.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').toLowerCase().split(/[^a-z0-9]+/u);
  return new Set(parts.filter((part) => part.length >= MIN_WORD && !COMMON_WORDS.has(part)));
};

const addedLines = (patch: string): string[] => patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));

const moduleWords = (module: ArchitectureModule): Set<string> =>
  wordsOf([posix.basename(module.path).replace(/\.[^.]+$/u, ''), ...module.exports].join(' '));

/** True when the module is in a changed file's folder, its parent folder, or a sibling folder. */
const isNeighbour = (module: ArchitectureModule, folders: ReadonlySet<string>): boolean => {
  const folder = posix.dirname(module.path);
  return [...folders].some((changed) => folder === changed || folder === posix.dirname(changed) || posix.dirname(folder) === posix.dirname(changed));
};

/**
 * The modules most related to `blocks`: name overlap with the added code counts double, being nearby counts once.
 * Unrelated modules are left out; at most `limit` are returned, most related first.
 */
export const architectureSlice = (
  modules: readonly ArchitectureModule[],
  blocks: readonly Pick<ReviewRequest, 'filePath' | 'patch'>[],
  limit: number,
): ArchitectureModule[] => {
  const terms = wordsOf(blocks.flatMap((block) => addedLines(block.patch)).join('\n'));
  const folders = new Set(blocks.map((block) => posix.dirname(block.filePath)));
  return modules
    .map((module) => {
      const overlap = [...moduleWords(module)].filter((word) => terms.has(word)).length;
      return { module, score: overlap * 2 + (isNeighbour(module, folders) ? 1 : 0) };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => (a.score === b.score ? a.module.path.localeCompare(b.module.path) : b.score - a.score))
    .slice(0, limit)
    .map((entry) => entry.module);
};

export interface FileDeclarations {
  readonly filePath: string;
  readonly lines: readonly string[];
}

/** The added declaration lines per changed file, bounded per file and in total. */
export const newDeclarations = (blocks: readonly ReviewRequest[]): FileDeclarations[] => {
  const byFile = new Map<string, string[]>();
  let total = 0;
  for (const block of blocks) {
    const lines = byFile.get(block.filePath) ?? [];
    for (const line of addedLines(block.patch).filter((candidate) => DECLARATION.test(candidate))) {
      const text = line.slice(1).trim();
      if (lines.length >= MAX_DECLARATION_LINES_PER_FILE || total + text.length > MAX_DECLARATION_CHARS) {
        break;
      }
      total += text.length;
      lines.push(text);
    }
    byFile.set(block.filePath, lines);
  }
  return [...byFile].filter(([, lines]) => lines.length > 0).map(([filePath, lines]) => ({ filePath, lines }));
};
