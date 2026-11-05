/** Architecture reviews use complete implementations and a fresh search across the repository. */
import type { ArchitectureModule, ReviewRequest, Rule } from '../shared/protocol';
import { architectureSlice } from './architecture';
import { importCandidates, relativeImports } from './investigation';
import { redactSecrets } from './redact';
import { reviewInventory } from './reviewInventory';
import { isCodeFileName, isSourceCodePath } from './standardsSources';
import { readWorkspaceFile } from './workspace';

const MAX_SEARCH_CHARS = 16_000_000;
const MAX_PROMPT_CHARS = 400_000;
const MAX_FILE_BYTES = 2_000_000;
const MAX_FILES = 60;

export const needsComponentContext = (rule: Rule): boolean =>
  rule.id === 'no-dead-code' || /architect|consolidat|reus|abstraction|layer|boundar|dependenc/iu.test(`${rule.category} ${rule.title} ${rule.check}`);

interface ReviewSource {
  readonly path: string;
  readonly content: string;
}

export interface ComponentContext {
  readonly inventory: readonly string[];
  readonly omittedDirectories: readonly string[];
  readonly searched: readonly string[];
  readonly unsearched: readonly string[];
  readonly files: readonly ReviewSource[];
  readonly omittedSources: readonly string[];
  readonly imports: readonly { readonly path: string; readonly targets: readonly string[] }[];
  readonly limitations: string;
}

const readCode = async (root: string, path: string): Promise<string | undefined> => {
  try {
    const raw = await readWorkspaceFile(root, path, MAX_FILE_BYTES);
    return raw === undefined ? undefined : redactSecrets(raw);
  } catch {
    return undefined;
  }
};

/** Search complete eligible files, including tests; never silently sample a body for an absence claim. */
const searchSources = async (root: string, paths: readonly string[]): Promise<Map<string, string>> => {
  const sources = new Map<string, string>();
  let chars = 0;
  for (const path of paths) {
    if (chars >= MAX_SEARCH_CHARS) {
      break;
    }
    const content = await readCode(root, path);
    if (content !== undefined) {
      chars += content.length;
      if (chars <= MAX_SEARCH_CHARS) {
        sources.set(path, content);
      }
    }
  }
  return sources;
};

const dependencies = (path: string, content: string, known: ReadonlySet<string>): string[] =>
  relativeImports(content).flatMap((specifier) => {
    const resolved = importCandidates(path, specifier).find((candidate) => known.has(candidate));
    return resolved === undefined ? [] : [resolved];
  });

const symbols = (blocks: readonly ReviewRequest[], modules: readonly ArchitectureModule[]): Set<string> => {
  const changed = new Set(blocks.map((block) => block.filePath));
  const names = modules.filter((module) => changed.has(module.path)).flatMap((module) => module.exports);
  const declarations = blocks.flatMap((block) => [...block.patch.matchAll(/\b(?:class|interface|type|function|const|def|fn|func)\s+([A-Za-z_$][\w$]*)/gu)]);
  return new Set([...names, ...declarations.flatMap((match) => match[1] === undefined ? [] : [match[1]])]);
};

const references = (content: string, names: ReadonlySet<string>): boolean =>
  [...content.matchAll(/[A-Za-z_$][\w$]*/gu)].some((match) => names.has(match[0]));

const dependencyClosure = (seeds: readonly string[], imports: ComponentContext['imports']): string[] => {
  const graph = new Map(imports.map((item) => [item.path, item.targets]));
  const paths = new Set(seeds);
  for (const path of paths) {
    for (const target of graph.get(path) ?? []) {
      paths.add(target);
    }
  }
  return [...paths];
};

/** Changed files, imports and callers first; then similar implementations anywhere in the repository. */
const prioritize = (
  blocks: readonly ReviewRequest[], modules: readonly ArchitectureModule[], sources: ReadonlyMap<string, string>,
): { paths: string[]; imports: ComponentContext['imports'] } => {
  const changed = [...new Set(blocks.map((block) => block.filePath))];
  const known = new Set(sources.keys());
  const imports = [...sources].map(([path, content]) => ({ path, targets: dependencies(path, content, known) }));
  const direct = dependencyClosure(changed, imports);
  const names = symbols(blocks, modules);
  const related = [...sources].filter(([path, content]) => !changed.includes(path) && references(content, names)).map(([path]) => path);
  const callers = imports.filter((item) => item.targets.some((target) => changed.includes(target))).map((item) => item.path);
  const candidates = [...sources.keys()].map((path) => ({ path, purpose: '', exports: [] }));
  const ranked = architectureSlice([...modules, ...candidates], blocks, sources.size + modules.length).map((module) => module.path);
  return { paths: [...new Set([...changed, ...direct, ...callers, ...related, ...ranked])], imports };
};

const completeSources = (paths: readonly string[], sources: ReadonlyMap<string, string>): ReviewSource[] => {
  const files: ReviewSource[] = [];
  let chars = 0;
  for (const path of paths) {
    const content = sources.get(path);
    if (content === undefined) {
      continue;
    }
    const numbered = content.split(/\r?\n/u).map((line, index) => `${String(index + 1)}| ${line}`).join('\n');
    if (files.length < MAX_FILES && chars + numbered.length <= MAX_PROMPT_CHARS) {
      files.push({ path, content: numbered });
      chars += numbered.length;
    }
  }
  return files;
};

export const collectComponentContext = async (
  root: string, blocks: readonly ReviewRequest[], modules: readonly ArchitectureModule[], requestedPaths: readonly string[] = [],
): Promise<ComponentContext> => {
  const inventory = await reviewInventory(root);
  const known = new Set(inventory.paths);
  if (requestedPaths.some((path) => !known.has(path) || !isSourceCodePath(path))) {
    throw new Error('Additional evidence must name eligible source files from the current repository inventory');
  }
  // Documentation and data files are never source evidence, so a changed README must not block the review. A code
  // file stays required even when it is unsafe or excluded (outside the workspace, hidden), so that still fails closed.
  const primary = blocks.map((block) => block.filePath).filter(isCodeFileName);
  const paths = [...new Set([...primary.filter(isSourceCodePath), ...requestedPaths, ...inventory.paths])];
  const sources = await searchSources(root, paths);
  const priority = prioritize(blocks, modules, sources);
  const files = completeSources([...new Set([...primary, ...requestedPaths, ...priority.paths])], sources);
  const included = new Set(files.map((file) => file.path));
  const missing = [...new Set([...primary, ...requestedPaths])].filter((path) => !included.has(path));
  if (missing.length > 0) {
    throw new Error(`Component review needs complete source files that could not be included safely within its budget: ${missing.join(', ')}`);
  }
  return {
    inventory: paths, omittedDirectories: inventory.omittedDirectories,
    searched: [...sources.keys()], unsearched: paths.filter((path) => !sources.has(path)),
    files, omittedSources: paths.filter((path) => !included.has(path)), imports: priority.imports,
    limitations: 'Inventory covers eligible source code, including tests; excludes hidden, dependency and build directories. Search is lexical, not proof of usage or non-usage. Import edges resolve relative imports only; aliases, dynamic loading and other language module systems may be unresolved. Source bodies are complete, never excerpts. Only listed files were supplied; other bodies, inaccessible files and budget omissions are unknown. Limits: 30,000 directory entries, depth 32, 16 million search characters, 60 supplied files and 400,000 supplied source characters.',
  };
};
