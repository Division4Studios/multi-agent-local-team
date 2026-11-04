import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import * as vscode from 'vscode';
import type { GitRepository } from '../git/gitApi';
import { isSourceCodePath } from '../reviewer/standardsSources';
import { readWorkspaceFile } from '../reviewer/workspace';
import { evidencePath, workflowPath } from './evidence';
import { infraPath } from './infrastructure';
import { extractFile } from './extract';
import type { FileFacts } from './extract';
import { buildGraph } from './graph';
import type { Snapshot } from './graph';
import { withUnderstanding } from './knowledge';
import { loadRevision, saveSnapshot } from './storage';

const MAX_BYTES = 512_000;
const MAX_FILES = 6000;
const GROUP_SIZE = 6;
const EXCLUDE = '**/{.*,node_modules,out,dist,build,coverage,target,vendor,bin,obj,__pycache__}/**';
export const SOURCE_GLOB = '**/{*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,py,go,rs,java,kt,cs,rb,php,swift,vue,svelte,c,cc,cpp,h,hpp,sql,mmd,mermaid,tf},*.malt-model.json,*.trace.json,Dockerfile*,*compose*.yml,*compose*.yaml}';
export const WORKFLOW_GLOB = '.github/workflows/*.{yml,yaml}';
export const relativePath = (folder: vscode.Uri, uri: vscode.Uri): string => relative(folder.fsPath, uri.fsPath).replaceAll('\\', '/');
const modelPath = (path: string): boolean => workflowPath(path) || ((evidencePath(path) || infraPath(path)) && isSourceCodePath(`${path  }.ts`));
export const eligible = (path: string): boolean => (isSourceCodePath(path) || modelPath(path)) && !/(?:^|\/)(?:bin|obj|__pycache__)\//u.test(path) && !/[\\:]/u.test(path);

export interface MapHead { readonly branch: string; readonly commit: string }
export const headOf = (repository: GitRepository | undefined): MapHead => {
  const head = repository?.state.HEAD;
  return { branch: head?.name ?? (head?.commit === undefined ? '(workspace)' : `(detached ${head.commit})`), commit: head?.commit ?? '' };
};

export const workingFiles = async (folder: vscode.WorkspaceFolder): Promise<string[]> => {
  const [files, workflows] = await Promise.all([vscode.workspace.findFiles(new vscode.RelativePattern(folder, SOURCE_GLOB), EXCLUDE), vscode.workspace.findFiles(new vscode.RelativePattern(folder, WORKFLOW_GLOB), null)]);
  const uris = [...files, ...workflows];
  return uris.map((uri) => relativePath(folder.uri, uri)).filter(eligible);
};
export const allowedPaths = async (folder: vscode.Uri, repo: GitRepository | undefined, paths: string[]): Promise<string[]> => {
  if (repo === undefined) {
    return paths;
  }
  const allowed: string[] = [];
  for (let start = 0; start < paths.length; start += 100) {
    const group = paths.slice(start, start + 100);
    const absolute = group.map((path) => vscode.Uri.joinPath(folder, path).fsPath);
    const ignored = await repo.checkIgnore(absolute);
    allowed.push(...group.filter((path) => !ignored.has(vscode.Uri.joinPath(folder, path).fsPath)));
  }
  return allowed;
};

type Reader = (path: string) => Promise<string | undefined>;
export const workingReader = (folder: vscode.WorkspaceFolder): Reader => async (path) => {
  try {
    return await readWorkspaceFile(folder.uri.fsPath, path, MAX_BYTES);
  } catch {
    return undefined;
  }
};

export const revisionReader = (repo: GitRepository, commit: string, folder: vscode.Uri): Reader => async (path) => {
  if (!eligible(path) || !/^(?:[\da-f]{40}|[\da-f]{64})$/u.test(commit) || repo.getObjectDetails === undefined || repo.show === undefined) {
    return undefined;
  }
  const absolute = vscode.Uri.joinPath(folder, path).fsPath;
  const detail = await repo.getObjectDetails(commit, absolute);
  if (!/^100(?:644|755)$/u.test(detail.mode) || detail.size > MAX_BYTES) {
    return undefined;
  }
  const content = await repo.show(commit, absolute);
  return Buffer.byteLength(content) <= MAX_BYTES ? content : undefined;
};

export const readFacts = async (paths: readonly string[], read: Reader, live: () => boolean): Promise<Map<string, FileFacts | undefined>> => {
  const facts = new Map<string, FileFacts | undefined>();
  for (let start = 0; start < paths.length && live(); start += GROUP_SIZE) {
    await Promise.all(paths.slice(start, start + GROUP_SIZE).map(async (path) => {
      const source = await read(path);
      facts.set(path, source === undefined || source.includes('\0') ? undefined : extractFile(path, source));
    }));
  }
  return facts;
};

export const bounded = (paths: string[]): string[] => [...new Set(paths)].sort((a, b) => a.localeCompare(b)).slice(0, MAX_FILES);
export const snapshotOf = (facts: ReadonlyMap<string, FileFacts | undefined>, head: MapHead, total: number): Snapshot => {
  const files = [...facts.values()].filter((f): f is FileFacts => f !== undefined).sort((a, b) => a.path.localeCompare(b.path));
  return { ...buildGraph(files), ...head, version: 1, generatedAt: new Date().toISOString(), skipped: total - files.length };
};

/** Diffing the empty tree enumerates the pinned commit through the built-in Git API, also in shallow clones. */
export const revision = async (map: { readonly folder: vscode.WorkspaceFolder; readonly noteKey: Buffer }, repo: GitRepository, head: MapHead, live: () => boolean): Promise<Snapshot> => {
  const { folder, noteKey } = map;
  const cached = await loadRevision(folder.uri.fsPath, head.commit);
  if (cached !== undefined) {
    return await withUnderstanding(folder.uri.fsPath, noteKey, { ...cached, branch: head.branch });
  }
  if (repo.diffBetweenWithStats2 === undefined || repo.show === undefined || repo.getObjectDetails === undefined) {
    throw new Error('This Git provider cannot read branch trees.');
  }
  const emptyTree = createHash(head.commit.length === 64 ? 'sha256' : 'sha1').update('tree 0\0').digest('hex');
  const changes = await repo.diffBetweenWithStats2(`${emptyTree}..${head.commit}`);
  const paths = changes.map((change) => relativePath(folder.uri, change.uri)).filter(eligible);
  const facts = await readFacts(bounded(paths), revisionReader(repo, head.commit, folder.uri), live);
  const snapshot = snapshotOf(facts, head, paths.length);
  if (live()) {
    await saveSnapshot(folder.uri.fsPath, 'commit', snapshot, live);
  }
  return await withUnderstanding(folder.uri.fsPath, noteKey, snapshot);
};
