import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { revealTrackedHunk } from '../../commands';
import { hunkId, newFileHunks } from '../../diff/unifiedDiff';
import { HunkStore } from '../../review/hunkStore';
import type { TrackedHunk } from '../../review/hunkStore';
import { ChangesTreeProvider } from '../../views/changesView';
import { ConsolidationCheck } from '../../review/consolidation';
import type { ConsolidationRequest } from '../../shared/protocol';
import { MemoryStorage, testCheck, testReview, testRule } from './testUtils';
import type { TestCase } from './harness';

const CONTENT = `${Array.from({ length: 160 }, () => 'identical line').join('\n')}\n`;
const REVIEW = testReview([], []);

const blocksFor = (uri: vscode.Uri, relativePath: string): TrackedHunk[] =>
  newFileHunks(CONTENT).map((hunk) => ({ id: hunkId(relativePath, hunk), uri, relativePath, hunk }));

const itemsFor = (provider: ChangesTreeProvider): vscode.TreeItem[] =>
  provider.getChildren().flatMap((file) => provider.getChildren(file).map((node) => provider.getTreeItem(node)));

const selectedLine = (uri: vscode.Uri): number | undefined =>
  vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === uri.toString())?.selection.start.line;

export const tests: readonly TestCase[] = [
  {
    name: 'changes tree: repeated blocks have distinct stable rows and retain shared reviews after line shifts',
    run: (): void => {
      const store = new HunkStore(new MemoryStorage());
      const provider = new ChangesTreeProvider(store, new ConsolidationCheck(store, () => undefined));
      const uri = vscode.Uri.file('/workspace/repeated.txt');
      const blocks = blocksFor(uri, 'repeated.txt');
      const [first, second] = blocks;
      assert.ok(first !== undefined && second !== undefined);
      try {
        assert.equal(blocks.length, 2);
        assert.equal(first.id, second.id, 'reproduce the content-ID collision');
        store.setFileHunks(uri, blocks);
        const items = itemsFor(provider);
        assert.deepEqual(items.map((item) => item.label), ['Lines 1–80', 'Lines 81–160']);
        assert.equal(new Set(items.map((item) => item.id)).size, 2);
        assert.ok(items.every((item) => item.id !== undefined));
        assert.deepEqual(items.map((item) => item.command?.arguments), [[first.id, 0], [second.id, 80]]);
        store.setState(first.id, { status: 'reviewed', review: REVIEW });
        store.setFileHunks(uri, blocksFor(uri, 'repeated.txt'));
        assert.deepEqual(itemsFor(provider).map((item) => item.id), items.map((item) => item.id));
        assert.ok(itemsFor(provider).every((item) => item.description === REVIEW.overview.summary));
        const shifted = blocks.map((block) => ({ ...block, hunk: { ...block.hunk, startLine: block.hunk.startLine + 5, endLine: block.hunk.endLine + 5 } }));
        store.setFileHunks(uri, shifted);
        assert.ok(shifted.every((block) => hunkId(block.relativePath, block.hunk) === first.id && store.state(block.id).review === REVIEW));
        assert.equal(new Set(itemsFor(provider).map((item) => item.id)).size, 2);
        assert.equal(store.get(second.id, 80), undefined, 'stale position must not fall back to the first duplicate');
        assert.equal(store.get(second.id, 85)?.hunk.startLine, 85);
      } finally {
        vscode.Disposable.from(provider, store).dispose();
      }
    },
  },
  {
    name: 'changes tree: rules are grouped and sorted running, failed, passed, not run, not applicable',
    run: (): void => {
      const store = new HunkStore(new MemoryStorage());
      const provider = new ChangesTreeProvider(store, new ConsolidationCheck(store, () => undefined));
      const uri = vscode.Uri.file('/workspace/grouped.txt');
      const [block] = blocksFor(uri, 'grouped.txt');
      assert.ok(block !== undefined);
      const [passing, failing, running, waiting, skipped] = [testRule('pass', 'Style'), testRule('fail', 'Security'),
        testRule('run', 'style'), testRule('wait', 'Testing'), testRule('skip', 'Testing')];
      try {
        store.setFileHunks(uri, [block]);
        const rules = [passing, failing, running, waiting, skipped];
        const review = testReview(rules, ['pass', 'fail', 'run', 'wait'], [testCheck(passing, 'pass'), testCheck(failing, 'fail')]);
        store.setState(block.id, { status: 'reviewing', review, running: ['run'] });
        const [file] = provider.getChildren();
        const [hunk] = file === undefined ? [] : provider.getChildren(file);
        assert.ok(hunk !== undefined);
        const groups = provider.getChildren(hunk);
        assert.deepEqual(groups.map((group) => provider.getTreeItem(group).label), ['style', 'Security', 'Testing'], 'case-insensitive groups, most urgent first');
        const rows = groups.flatMap((group) => provider.getChildren(group).map((node) => provider.getTreeItem(node)));
        assert.deepEqual(rows.map((item) => item.label), ['Rule run', 'Rule pass', 'Rule fail', 'Rule wait', 'Rule skip']);
        assert.deepEqual(rows.map((item) => item.command?.arguments), [undefined, [block.id, 0, 'pass'], [block.id, 0, 'fail'], undefined, undefined], 'only checked rules open details');
      } finally {
        vscode.Disposable.from(provider, store).dispose();
      }
    },
  },
  {
    name: 'changes tree: identical content in different files has independent row identities',
    run: (): void => {
      const store = new HunkStore(new MemoryStorage());
      const provider = new ChangesTreeProvider(store, new ConsolidationCheck(store, () => undefined));
      try {
        for (const path of ['a.txt', 'b.txt']) {
          const uri = vscode.Uri.file(`/workspace/${path}`);
          store.setFileHunks(uri, blocksFor(uri, path));
        }
        const items = itemsFor(provider);
        assert.equal(items.length, 4);
        assert.equal(new Set(items.map((item) => item.id)).size, 4);
        assert.equal(new Set(provider.getChildren().map((node) => provider.getTreeItem(node).id)).size, 2);
      } finally {
        vscode.Disposable.from(provider, store).dispose();
      }
    },
  },
  {
    name: 'reveal command: each repeated block opens its own line and invalid or stale requests do nothing',
    run: async (): Promise<void> => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      assert.ok(folder !== undefined);
      const uri = vscode.Uri.joinPath(folder.uri, 'repeated-navigation.txt');
      await vscode.workspace.fs.writeFile(uri, Buffer.from(CONTENT));
      const store = new HunkStore(new MemoryStorage());
      const provider = new ChangesTreeProvider(store, new ConsolidationCheck(store, () => undefined));
      const blocks = blocksFor(uri, 'repeated-navigation.txt');
      const [first, second] = blocks;
      assert.ok(first !== undefined && second !== undefined);
      try {
        store.setFileHunks(uri, blocks);
        for (const [index, item] of itemsFor(provider).entries()) {
          const args: readonly unknown[] = item.command?.arguments ?? [];
          await revealTrackedHunk(store, args[0], args[1]);
          assert.equal(selectedLine(uri), index * 80);
        }
        for (const invalid of ['80', -1, 0.5, NaN, Infinity, null, {}]) {
          await revealTrackedHunk(store, first.id, invalid);
          assert.equal(selectedLine(uri), 80);
        }
        await revealTrackedHunk(store, { tracked: { uri: 'file:///outside.txt' } }, 0);
        await revealTrackedHunk(store, 'unknown-id', 0);
        assert.equal(selectedLine(uri), 80);
        store.setFileHunks(uri, [first]);
        await revealTrackedHunk(store, second.id, 80);
        assert.equal(selectedLine(uri), 80, 'removed occurrence must not navigate to its surviving duplicate');
        await revealTrackedHunk(store, first.id);
        assert.equal(selectedLine(uri), 0, 'legacy id-only navigation still works');
      } finally {
        vscode.Disposable.from(provider, store).dispose();
      }
    },
  },
  {
    name: 'consolidation: one call over every changed block; findings appear above the files',
    run: async (): Promise<void> => {
      const store = new HunkStore(new MemoryStorage());
      const requests: ConsolidationRequest[] = [];
      const finding = { title: 'Merge the card components', files: ['a.txt', 'b.txt'], note: 'n', detail: 'd', anchors: [] };
      const check = new ConsolidationCheck(store, () => ({
        consolidation: async (request: ConsolidationRequest): Promise<readonly (typeof finding)[]> => {
          requests.push(request);
          return await Promise.resolve([finding]);
        },
      }));
      const provider = new ChangesTreeProvider(store, check);
      try {
        for (const path of ['a.txt', 'b.txt']) {
          const uri = vscode.Uri.file(`/workspace/${path}`);
          store.setFileHunks(uri, blocksFor(uri, path));
        }
        assert.equal(provider.getChildren().length, 2, 'no consolidation row before the first check');
        await check.run();
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.blocks.length, 4);
        const [top] = provider.getChildren();
        assert.ok(top !== undefined);
        assert.equal(provider.getTreeItem(top).label, 'Consolidation');
        const findings = provider.getChildren(top).map((node) => provider.getTreeItem(node));
        assert.deepEqual(
          findings.map((item) => [item.label, item.description, item.command?.command, item.command?.arguments, item.contextValue]),
          [[finding.title, 'a.txt, b.txt', 'malt.showFindingLocation', [0, 0, 'changes'], 'malt.finding']],
          'selecting a finding goes to where it applies; its details are an inline action',
        );
      } finally {
        vscode.Disposable.from(provider, check, store).dispose();
      }
    },
  },
];
