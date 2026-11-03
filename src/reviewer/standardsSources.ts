/**
 * Collects the files a standards scan reads: agent skills and instructions, Markdown docs and lint/format configs.
 * Bounded by file count, per-file size and total size so a large repository cannot blow up the prompt.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

const MAX_FILES = 150;
const MAX_FILE_CHARS = 30_000;
const MAX_TOTAL_CHARS = 350_000;
const MAX_DEPTH = 6;

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'out', 'dist', 'build', 'coverage', '.vscode-test', '.next', 'target', 'vendor', '.malt',
]);
const ALLOWED_DOT_DIRECTORIES: ReadonlySet<string> = new Set(['.claude', '.codex', '.github', '.cursor']);
const CONFIG_FILE = /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.\w+)?|tsconfig(?:\.\w+)?\.json|\.editorconfig|\.prettierrc(?:\.\w+)?|biome\.jsonc?|\.cursorrules)$/u;
const SKIPPED_MARKDOWN: ReadonlySet<string> = new Set(['CHANGELOG.md', 'LICENSE.md']);

const isCandidate = (name: string): boolean =>
  (name.toLowerCase().endsWith('.md') && !SKIPPED_MARKDOWN.has(name)) || CONFIG_FILE.test(name);

const shouldDescend = (name: string): boolean =>
  !SKIPPED_DIRECTORIES.has(name) && (!name.startsWith('.') || ALLOWED_DOT_DIRECTORIES.has(name));

/** Lower ranks are read first: agent instructions, then top-level docs, then everything else. */
const rank = (path: string): number => {
  if (/^\.(?:claude|codex|cursor)\//u.test(path) || /^(?:CLAUDE|AGENTS)\.md$/u.test(path)) {
    return 0;
  }
  if (CONFIG_FILE.test(path) || /^(?:README|CONTRIBUTING|ARCHITECTURE)\.md$/iu.test(path)) {
    return 1;
  }
  return path.startsWith('docs/') ? 2 : 3;
};

const walk = async (root: string, directory: string, depth: number, found: string[]): Promise<void> => {
  if (depth > MAX_DEPTH) {
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory() && shouldDescend(entry.name)) {
      await walk(root, full, depth + 1, found);
    } else if (entry.isFile() && isCandidate(entry.name)) {
      found.push(relative(root, full).split('\\').join('/'));
    }
  }
};

export const collectStandardsSources = async (root: string): Promise<SourceFile[]> => {
  const paths: string[] = [];
  await walk(root, root, 0, paths);
  paths.sort((a, b) => (rank(a) === rank(b) ? a.localeCompare(b) : rank(a) - rank(b)));

  const sources: SourceFile[] = [];
  let total = 0;
  for (const path of paths.slice(0, MAX_FILES)) {
    const content = (await readFile(join(root, path), 'utf8')).slice(0, MAX_FILE_CHARS);
    if (total + content.length > MAX_TOTAL_CHARS) {
      break;
    }
    total += content.length;
    sources.push({ path, content });
  }
  return sources;
};
