/**
 * Collects the files a standards scan reads: agent skills and instructions, Markdown docs and lint/format configs,
 * and (for the architecture map) the start of each source file.
 * Bounded by file count, per-file size and total size so a large repository cannot blow up the prompt.
 * Symlinked files and directories are never followed (Dirent reports them as links, not files/directories),
 * and every read goes through the confined reader.
 */
import { createHash } from 'node:crypto';
import { infraPath, infrastructure } from '../architecture/infrastructure';
import { readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { readWorkspaceFile } from './workspace';

export interface SourceFile {
  readonly path: string;
  readonly content: string;
  readonly fingerprint?: string;
}

const MAX_FILES = 150;
const MAX_FILE_CHARS = 30_000;
const MAX_SOURCE_BYTES = 1_000_000;
const MAX_TOTAL_CHARS = 350_000;
const MAX_DEPTH = 6;

/** Architecture map: only the head of each source file (imports, exports, top-level declarations) is read. */
const MAX_CODE_FILES = 400;
const MAX_CODE_HEAD_CHARS = 8_000;
const MAX_CODE_TOTAL_CHARS = 350_000;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|swift|vue|svelte|c|cc|cpp|h|hpp)$/u;
const TEST_FILE = /(?:\.(?:test|spec)\.|(?:^|\/)(?:__tests__|tests?)\/)/u;

const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'out', 'dist', 'build', 'coverage', '.vscode-test', '.next', 'target', 'vendor', '.malt',
]);
const ALLOWED_DOT_DIRECTORIES: ReadonlySet<string> = new Set(['.claude', '.codex', '.agents', '.github', '.cursor']);
const CONFIG_FILE = /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.\w+)?|tsconfig(?:\.\w+)?\.json|\.editorconfig|\.prettierrc(?:\.\w+)?|biome\.jsonc?|\.cursorrules)$/u;
const SKIPPED_MARKDOWN: ReadonlySet<string> = new Set(['CHANGELOG.md', 'LICENSE.md']);

const isCandidate = (name: string): boolean =>
  (name.toLowerCase().endsWith('.md') && !SKIPPED_MARKDOWN.has(name)) || CONFIG_FILE.test(name);

/**
 * Whether a workspace-relative path is source code by the same rules the code scan uses: a code extension, and no
 * hidden (dot) or dependency/build folder anywhere on the path. Stricter than discovery (no dot folders at all),
 * so data files (`.env`, `secrets.json`, keys, notes) can never be read as "code".
 */
export const isSourceCodePath = (path: string): boolean => {
  const segments = path.split('/');
  const name = segments.at(-1) ?? '';
  return CODE_FILE.test(name) && segments.every((segment) => segment !== '' && segment !== '..' && !segment.startsWith('.') && !SKIPPED_DIRECTORIES.has(segment));
};

const shouldDescend = (name: string): boolean =>
  !SKIPPED_DIRECTORIES.has(name) && (!name.startsWith('.') || ALLOWED_DOT_DIRECTORIES.has(name));

/** Architecture decision records and design docs, wherever they live. */
const ARCHITECTURE_DOC = /(?:^|\/)(?:adrs?|decisions|architecture|design)\/|(?:^|\/)(?:ARCHITECTURE|DESIGN)\.md$/iu;

/** Lower ranks are read first: agent instructions, then top-level and architecture docs, then everything else. */
const rank = (path: string): number => {
  if (/^\.(?:claude|codex|agents|cursor)\//u.test(path) || /^(?:CLAUDE|AGENTS)\.md$/u.test(path)) {
    return 0;
  }
  if (CONFIG_FILE.test(path) || ARCHITECTURE_DOC.test(path) || /^(?:README|CONTRIBUTING)\.md$/iu.test(path)) {
    return 1;
  }
  return path.startsWith('docs/') ? 2 : 3;
};

interface Walk {
  readonly root: string;
  readonly matches: (name: string) => boolean;
  readonly found: string[];
}

const walk = async (search: Walk, directory: string, depth: number): Promise<void> => {
  if (depth > MAX_DEPTH) {
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory() && shouldDescend(entry.name)) {
      await walk(search, full, depth + 1);
    } else if (entry.isFile() && search.matches(entry.name)) {
      search.found.push(relative(search.root, full).split('\\').join('/'));
    }
  }
};

/** Workspace-relative paths of matching files, never following links. */
const findFiles = async (realRoot: string, matches: (name: string) => boolean): Promise<string[]> => {
  const found: string[] = [];
  await walk({ root: realRoot, matches, found }, realRoot, 0);
  return found;
};

/** Keep declarations, implementation and exit paths in view within the per-file prompt budget. */
const implementationSample = (source: string, limit: number): string => {
  if (source.length <= limit) {
    return source;
  }
  const marker = '\n[excerpt omitted]\n';
  const part = Math.floor((limit - marker.length * 2) / 3);
  const middle = Math.floor((source.length - part) / 2);
  return [source.slice(0, part), source.slice(middle, middle + part), source.slice(-part)].join(marker);
};

/** Reads a source through the confined reader; unsafe (linked/outside) or oversized files are skipped. */
const readSource = async (root: string, path: string, maxChars: number, sample: boolean): Promise<SourceFile | undefined> => {
  try {
    const raw = await readWorkspaceFile(root, path, MAX_SOURCE_BYTES);
    if(raw!==undefined&&infraPath(path)){
      const entries=infrastructure(path,raw).flatMap(d=>d.items.map(item=>({name:item.label,kind:item.group})));
      return {path,content:JSON.stringify(entries).slice(0,maxChars),fingerprint:createHash('sha256').update(raw.replaceAll('\\r\\n','\\n')).digest('hex')};
    }
    return raw === undefined ? undefined : { path, content: sample ? implementationSample(raw, maxChars) : raw.slice(0, maxChars), fingerprint: createHash('sha256').update(raw.replaceAll('\r\n', '\n')).digest('hex') };
  } catch {
    return undefined;
  }
};

interface ReadLimits {
  readonly fileChars: number;
  readonly sample?: boolean;
  readonly totalChars: number;
}

const readSources = async (realRoot: string, paths: readonly string[], limits: ReadLimits): Promise<SourceFile[]> => {
  const sources: SourceFile[] = [];
  let total = 0;
  for (const [i, path] of paths.entries()) {
    const limit = limits.sample === true ? Math.min(limits.fileChars, Math.floor((limits.totalChars - total) / (paths.length - i))) : limits.fileChars;
    const file = await readSource(realRoot, path, limit, limits.sample === true);
    if (file === undefined) {
      continue;
    }
    if (total + file.content.length > limits.totalChars) {
      break;
    }
    total += file.content.length;
    sources.push(file);
  }
  return sources;
};

export const collectStandardsSources = async (root: string): Promise<SourceFile[]> => {
  const realRoot = await realpath(root);
  const paths = await findFiles(realRoot, isCandidate);
  paths.sort((a, b) => (rank(a) === rank(b) ? a.localeCompare(b) : rank(a) - rank(b)));
  return await readSources(realRoot, paths.slice(0, MAX_FILES), { fileChars: MAX_FILE_CHARS, totalChars: MAX_TOTAL_CHARS });
};

/** Source files (tests excluded), shallowest first, each cut to its head: enough to see what it is and exports. */
export const collectCodeSources = async (root: string): Promise<SourceFile[]> => {
  const realRoot = await realpath(root);
  const depth = (path: string): number => path.split('/').length;
  const paths = (await findFiles(realRoot, (name) => CODE_FILE.test(name) || infraPath(name)))
    .filter((path) => !TEST_FILE.test(path))
    .sort((a, b) => (depth(a) === depth(b) ? a.localeCompare(b) : depth(a) - depth(b)));
  return await readSources(realRoot, paths.slice(0, MAX_CODE_FILES), { fileChars: MAX_CODE_HEAD_CHARS, totalChars: MAX_CODE_TOTAL_CHARS, sample: true });
};
