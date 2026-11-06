/** The Reviewer sidebar, standards pages, and gap anchors resolved to real declarations. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { lineLabel } from '../../views/changesView';
import { enforceAnchors } from '../../reviewer/trust';
import { parseFinding } from '../../shared/protocol';
import type { Finding, StandardsDocument } from '../../shared/protocol';
import { FindingHighlight, findDeclarationLine, workspaceFile } from '../../editor/findingHighlight';
import { architecturePage, standardsPage } from '../../standards/standardsPages';
import { StandardsModel } from '../../standards/standardsModel';
import { ReviewerTreeProvider } from '../../views/reviewerView';
import { ReviewerManager } from '../../backend/reviewerManager';
import { Credentials } from '../../backend/credentials';
import { HunkStore } from '../../review/hunkStore';
import { hunkId, newFileHunks } from '../../diff/unifiedDiff';
import { MemoryStorage, testReview } from './testUtils';
import { gapId } from '../../shared/investigation';
import type { GapInvestigation } from '../../shared/investigation';
import { readInvestigations, saveInvestigation } from '../../standards/investigations';
import type { TestCase } from './harness';

const RUST = ['use crate::config::parse_config;', '', '/// Reads the config.', 'pub fn parse_config(path: &str) -> Config {', '    todo!()', '}', ''].join('\n');

const GAP: Finding = {
  title: 'No documented config error handling',
  files: ['src/lib.rs'],
  note: 'Two error styles are used.',
  detail: 'Decide on one.',
  anchors: [{ file: 'src/lib.rs', symbol: 'parse_config' }, { file: 'src/lib.rs', symbol: 'Config' }],
};

const STANDARDS: StandardsDocument = {
  version: 1,
  generatedAt: '2026-11-03T00:00:00.000Z',
  rules: [
    { id: 'naming', title: 'Use snake_case', check: 'Snake case?', category: 'Style', source: 'CLAUDE.md' },
    { id: 'layers', title: 'Keep IO in adapters', check: 'IO in adapters?', category: 'Architecture', source: 'Inferred from code: src/io.rs' },
    { id: 'docs', title: 'Document public fns', check: 'Documented?', category: 'style', source: 'AGENTS.md' },
  ],
  gaps: [GAP],
};

/** An empty secret store: the reviewer manager is only constructed, never started, in these tests. */
const fakeSecrets = (): vscode.SecretStorage => {
  const values = new Map<string, string>();
  return {
    get: async (key: string): Promise<string | undefined> => {
      await Promise.resolve();
      return values.get(key);
    },
    store: async (key: string, value: string): Promise<void> => {
      await Promise.resolve();
      values.set(key, value);
    },
    delete: async (key: string): Promise<void> => {
      await Promise.resolve();
      values.delete(key);
    },
    keys: async (): Promise<string[]> => {
      await Promise.resolve();
      return [...values.keys()];
    },
    onDidChange: new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event,
  };
};

const folder = (): vscode.WorkspaceFolder => {
  const first = vscode.workspace.workspaceFolders?.[0];
  if (first === undefined) {
    assert.fail('the test host must open a workspace folder');
  }
  return first;
};

const labels = (items: readonly vscode.TreeItem[]): string[] => items.map((item) => (typeof item.label === 'string' ? item.label : item.label?.label ?? ''));

type ReviewerTree = ReviewerTreeProvider;

const childLabels = (tree: ReviewerTree, node: Parameters<ReviewerTree['getTreeItem']>[0] | undefined): string[] =>
  labels(tree.getChildren(node).map((child) => tree.getTreeItem(child)));

/** Rows, what clicking them does, and the Standards and Gaps sub-trees. */
const assertRows = (tree: ReviewerTree): void => {
  const roots = tree.getChildren();
  const items = roots.map((node) => tree.getTreeItem(node));
  assert.deepEqual(labels(items), ['Reviewers health', 'Models & effort', 'Standards', 'Gaps', 'Architecture', 'Queue'], 'no separate Backend row');
  assert.deepEqual(items.map((item) => item.command?.command), [undefined, undefined, 'malt.showStandards', undefined, 'malt.showArchitecture', undefined],
    'Standards and Architecture open pages; nothing here rescans');
  const [, modelsNode, standardsNode, gapsNode] = roots;
  const types = tree.getChildren(modelsNode).map((node) => tree.getTreeItem(node));
  assert.deepEqual(labels(types), ['Block overview', 'Rule checks', 'Consolidation', 'Standards scan', 'Gap investigation']);
  assert.deepEqual(types.map((type) => type.description), ['sonnet · low effort', 'haiku · low effort', 'sonnet · low effort', 'opus · medium effort', 'sonnet · medium effort'], 'the defaults');
  assert.deepEqual(types[1]?.command?.arguments, ['check'], 'selecting a type opens its model and effort pickers');
  const groups = tree.getChildren(standardsNode);
  assert.deepEqual(labels(groups.map((node) => tree.getTreeItem(node))), ['Architecture', 'Style']);
  assert.deepEqual(childLabels(tree, groups[1]), ['Document public fns', 'Use snake_case']);
  const [gap] = tree.getChildren(gapsNode);
  assert.ok(gap !== undefined);
  assert.deepEqual(tree.getTreeItem(gap).command?.arguments, [0, 0], 'selecting a gap goes to its first declaration');
  assert.deepEqual(childLabels(tree, gap), ['parse_config', 'Config']);
};

const assertQueueDropsFinished = (tree: ReviewerTree, store: HunkStore): void => {
  const queueNode = tree.getChildren().at(-1);
  assert.ok(queueNode !== undefined);
  const uri = vscode.Uri.file('/workspace/a.rs');
  const [done, waiting] = newFileHunks(`${'a\n'.repeat(35)}\n${'b\n'.repeat(35)}`).map((hunk) => ({ id: hunkId('a.rs', hunk), uri, relativePath: 'a.rs', hunk }));
  assert.ok(done !== undefined && waiting !== undefined);
  store.setFileHunks(uri, [done, waiting]);
  store.setState(done.id, { status: 'reviewed', review: testReview([], []) });
  store.setState(waiting.id, { status: 'queued' });
  assert.equal(tree.getTreeItem(queueNode).description, '1 queued', 'finished blocks drop off the queue');
  store.setState(waiting.id, { status: 'reviewed', review: testReview([], []) });
  assert.equal(tree.getTreeItem(queueNode).description, 'idle');
};

export const tests: readonly TestCase[] = [
  {
    name: 'labels: a one-line block reads "Line 21", a range "Lines 21–24"',
    run: (): void => {
      assert.equal(lineLabel(20, 20), 'Line 21');
      assert.equal(lineLabel(20, 23), 'Lines 21–24');
    },
  },
  {
    name: 'anchors: only listed files and plain declaration names survive; old findings default to none',
    run: (): void => {
      const kept = enforceAnchors([
        { file: 'src/lib.rs', symbol: 'parse_config' },
        { file: 'src/lib.rs', symbol: 'config::Store.get' },
        { file: 'src/lib.rs', symbol: 'parse_config' },
        { file: 'src/other.rs', symbol: 'x' },
        { file: 'src/lib.rs', symbol: '<script>' },
        { file: 'src/lib.rs', symbol: 'a b' },
        { file: 'src/lib.rs', symbol: '../etc' },
      ], new Set(['src/lib.rs']));
      assert.deepEqual(kept.map((anchor) => anchor.symbol), ['parse_config', 'config::Store.get']);
      assert.deepEqual(parseFinding({ title: 't', files: [], note: 'n', detail: 'd' })?.anchors, []);
      assert.equal(parseFinding({ title: 't', files: [], note: 'n', detail: 'd', anchors: [{ file: 1 }] }), undefined);
    },
  },
  {
    name: 'anchors: paths from generated files must stay inside the workspace, by real location',
    run: async (): Promise<void> => {
      const root = folder();
      const base = await mkdtemp(join(tmpdir(), 'malt-anchor-outside-'));
      await writeFile(join(base, 'secret.txt'), 'outside the workspace');
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root.uri, 'inside.rs'), Buffer.from('fn x() {}'));
      await symlink(base, join(root.uri.fsPath, 'linked-outside'), 'junction');
      try {
        assert.equal((await workspaceFile(root, 'inside.rs'))?.fsPath.endsWith('inside.rs'), true, 'a real file inside resolves');
        assert.equal(await workspaceFile(root, 'linked-outside/secret.txt'), undefined, 'a link out of the workspace is refused');
        assert.equal(await workspaceFile(root, 'missing.rs'), undefined, 'a missing file fails closed');
        for (const path of ['../secret', 'src/../../x', '/etc/passwd', 'C:\\Windows\\x', '', 'src//lib.rs', '\\\\server\\share']) {
          assert.equal(await workspaceFile(root, path), undefined, path);
        }
      } finally {
        await rm(join(root.uri.fsPath, 'linked-outside'), { recursive: false, force: true });
        await rm(join(root.uri.fsPath, 'inside.rs'), { force: true });
        await rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'anchors: a workspace reached through a link (like macOS /var -> /private/var) opens files under its own path',
    run: async (): Promise<void> => {
      const base = await mkdtemp(join(tmpdir(), 'malt-linked-root-'));
      const realRoot = join(base, 'real-root');
      const linkedRoot = join(base, 'linked-root');
      await mkdir(join(realRoot, 'src'), { recursive: true });
      await writeFile(join(realRoot, 'src', 'lib.rs'), 'fn x() {}');
      await symlink(realRoot, linkedRoot, 'junction');
      try {
        const linkedFolder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(linkedRoot), name: 'linked', index: 0 };
        const opened = await workspaceFile(linkedFolder, 'src/lib.rs');
        assert.equal(opened?.fsPath, vscode.Uri.joinPath(linkedFolder.uri, 'src', 'lib.rs').fsPath, 'spelled as the workspace knows it, not as the resolved path');
      } finally {
        await rm(linkedRoot, { force: true });
        await rm(base, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'anchors: the declaration line wins over earlier uses; names are matched literally',
    run: (): void => {
      assert.equal(findDeclarationLine(RUST, 'parse_config'), 3);
      assert.equal(findDeclarationLine(RUST, 'config::parse_config'), 3, 'qualified names match their last segment');
      assert.equal(findDeclarationLine('let x = 1;\nfoo(x);', 'foo'), 1, 'falls back to the first use');
      assert.equal(findDeclarationLine(RUST, 'missing_fn'), undefined);
      assert.equal(findDeclarationLine('a.*b\n', '.*'), undefined, 'regex metacharacters never act as patterns');
    },
  },
  {
    name: 'pages: standards grouped by category with documented/inferred tags; architecture grouped by folder',
    run: (): void => {
      const page = standardsPage(STANDARDS);
      assert.deepEqual(page.groups.map((group) => group.heading), ['Architecture', 'Style', 'Always checked (MALT baseline)']);
      assert.deepEqual(page.groups[1]?.items.map((item) => item.title), ['Document public fns', 'Use snake_case'], 'categories merge case-insensitively');
      assert.deepEqual(page.groups[0]?.items[0]?.tags.slice(0, 2), ['Inferred from code', 'Source: src/io.rs']);
      const map = architecturePage({ version: 1, generatedAt: STANDARDS.generatedAt, modules: [
        { path: 'src/io/fs.rs', purpose: 'Files', exports: ['read'] },
        { path: 'Cargo.toml', purpose: 'Manifest', exports: [] },
      ] });
      assert.deepEqual(map.groups.map((group) => group.heading), ['(project root)', 'src/io/']);
    },
  },
  {
    name: 'reviewer view: one Reviewer row, standards categories → rules, gaps → declarations, queue drops finished blocks',
    run: async (): Promise<void> => {
      const root = folder();
      const file = vscode.Uri.joinPath(root.uri, '.malt', 'standards.json');
      await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(STANDARDS)));
      const output = vscode.window.createOutputChannel('MALT test', { log: true });
      const manager = new ReviewerManager(root.uri.fsPath, new Credentials(fakeSecrets()), output, '');
      const store = new HunkStore(new MemoryStorage());
      const model = new StandardsModel(root, undefined);
      const tree = new ReviewerTreeProvider(manager, store, model);
      try {
        await model.reload();
        assertRows(tree);
        assertQueueDropsFinished(tree, store);
      } finally {
        tree.dispose();
        model.dispose();
        store.dispose();
        manager.dispose();
        output.dispose();
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(root.uri, '.malt'), { recursive: true });
      }
    },
  },
  {
    name: 'gap investigation: saved results show the verdict in the tray, with the summary and evidence beneath',
    run: async (): Promise<void> => {
      const root = folder();
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root.uri, '.malt', 'standards.json'), Buffer.from(JSON.stringify(STANDARDS)));
      const investigation: GapInvestigation = {
        gapId: gapId(GAP),
        investigatedAt: '2026-11-04T00:00:00.000Z',
        verdict: 'partly',
        confidence: 'medium',
        plainSummary: 'Errors are handled two ways.',
        whatTheCodeDoes: 'w',
        evidence: [{ file: 'src/lib.rs', symbol: 'parse_config', quote: 'pub fn parse_config(path: &str) -> Config {', observation: 'Returns Config directly.' }],
        counterpoints: 'c',
        whyItMatters: 'm',
        recommendation: 'r',
        filesRead: ['src/lib.rs'],
      };
      const stale: GapInvestigation = { ...investigation, gapId: 'b'.repeat(24) };
      const model = new StandardsModel(root, undefined);
      const output = vscode.window.createOutputChannel('MALT test', { log: true });
      const manager = new ReviewerManager(root.uri.fsPath, new Credentials(fakeSecrets()), output, '');
      const tree = new ReviewerTreeProvider(manager, new HunkStore(new MemoryStorage()), model);
      try {
        await saveInvestigation(root, stale, []);
        await saveInvestigation(root, investigation, STANDARDS.gaps);
        await model.reload();
        const saved = await readInvestigations(root);
        assert.deepEqual(saved?.investigations.map((item) => item.gapId), [gapId(GAP)], 'investigations of gaps no longer recorded are pruned');
        const gapsNode = tree.getChildren().find((node) => tree.getTreeItem(node).label === 'Gaps');
        const [gapNode] = tree.getChildren(gapsNode);
        assert.ok(gapNode !== undefined);
        assert.equal(tree.getTreeItem(gapNode).description, 'Partly a gap · medium confidence');
        const children = tree.getChildren(gapNode).map((node) => tree.getTreeItem(node));
        assert.deepEqual(labels(children), ['In plain English', 'parse_config']);
        assert.deepEqual(children.map((child) => child.command?.command), ['malt.showInvestigation', 'malt.showEvidence']);
        assert.deepEqual(children[1]?.command?.arguments, [0, 0]);
      } finally {
        tree.dispose();
        model.dispose();
        manager.dispose();
        output.dispose();
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(root.uri, '.malt'), { recursive: true });
      }
    },
  },
  {
    name: 'gap investigation: investigations that finish at the same time are all saved',
    run: async (): Promise<void> => {
      const root = folder();
      const gaps: Finding[] = [0, 1, 2, 3, 4].map((index) => ({ ...GAP, title: `Gap ${String(index)}` }));
      const investigationOf = (gap: Finding): GapInvestigation => ({
        gapId: gapId(gap),
        investigatedAt: '2026-11-04T00:00:00.000Z',
        verdict: 'confirmed',
        confidence: 'high',
        plainSummary: gap.title,
        whatTheCodeDoes: 'w',
        evidence: [],
        counterpoints: 'c',
        whyItMatters: 'm',
        recommendation: 'r',
        filesRead: [],
      });
      try {
        await Promise.all(gaps.map(async (gap) => { await saveInvestigation(root, investigationOf(gap), gaps); }));
        const saved = await readInvestigations(root);
        assert.deepEqual(saved?.investigations.map((item) => item.plainSummary).sort(), gaps.map((gap) => gap.title), 'no completed investigation is lost');
      } finally {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(root.uri, '.malt'), { recursive: true });
      }
    },
  },
  {
    name: 'gap highlight: opens the file at the real declaration, outlines it and explains it on hover',
    run: async (): Promise<void> => {
      const root = folder();
      const file = vscode.Uri.joinPath(root.uri, 'src', 'lib.rs');
      await vscode.workspace.fs.writeFile(file, Buffer.from(RUST));
      const highlight = new FindingHighlight();
      try {
        const [anchor] = GAP.anchors;
        assert.ok(anchor !== undefined);
        assert.equal(await highlight.show(root, GAP, anchor, 'Standards gap'), true);
        const editor = vscode.window.activeTextEditor;
        assert.equal(editor?.document.uri.toString(), file.toString());
        assert.equal(editor.selection.start.line, 3, 'cursor lands on the declaration, not the earlier use');
        const hover = highlight.provideHover(editor.document, new vscode.Position(3, 4));
        const [content] = hover?.contents ?? [];
        // appendText escapes the (untrusted) text, turning spaces into &nbsp;, so match single words.
        assert.ok(content instanceof vscode.MarkdownString, 'hover is markdown');
        assert.ok(['Standards', 'documented', 'handling', 'Decide'].every((word) => content.value.includes(word)), content.value);
        assert.equal(content.isTrusted, undefined, 'hover links are never trusted: gap text cannot run commands');
        assert.equal(highlight.provideHover(editor.document, new vscode.Position(0, 0)), undefined, 'no hover outside the declaration');
        assert.equal(await highlight.show(root, { ...GAP, files: ['../escape.rs'] }, { file: '../escape.rs', symbol: 'x' }, 'Standards gap'), false);
      } finally {
        highlight.dispose();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(root.uri, 'src'), { recursive: true });
      }
    },
  },
];
