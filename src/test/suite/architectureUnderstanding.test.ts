import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFile } from '../../architecture/extract';
import { buildGraph } from '../../architecture/graph';
import type { Snapshot } from '../../architecture/graph';
import { reviewerMap, saveNote, saveScan, withUnderstanding } from '../../architecture/knowledge';
import { saveMapFile } from '../../architecture/storage';
import { ground, groundModules } from '../../reviewer/understanding';
import { loadArchitecture } from '../../reviewer/workspace';
import { parseDiscussion } from '../../shared/understanding';
import type { TestCase } from './harness';

const source = 'export function enqueue() { return buffer.push(1); }';
const analysis = { what: 'Queues an item.', whatEvidence: 'buffer.push(1)', why: 'Possibly to batch writes.', whyEvidence: 'batch writes for throughput', question: 'Why buffer these writes?' };
const snapshot = (branch: string, content: string): Snapshot => ({
  ...buildGraph([extractFile('src/queue.ts', content)]), version: 1, branch, commit: 'a'.repeat(40), generatedAt: '', skipped: 0,
});
export const tests: readonly TestCase[] = [
  {
    name: 'understanding: separates matched evidence from a hypothesis and rejects oversized chat turns',
    run: (): void => {
      const supported = ground(analysis, source);
      assert.equal(supported.whatEvidence, 'buffer.push(1)');
      assert.equal(supported.whyEvidence, '');
      assert.equal(supported.question, analysis.question);
      assert.equal(parseDiscussion({ path: 'x', source, context: '', dialogue: 'x'.repeat(22_001) }), undefined);
      assert.equal(parseDiscussion({ path: 'x', source, context: '', dialogue: 'why?' })?.dialogue, 'why?');
    },
  },
  {
    name: 'understanding: a clarification survives rescans, reaches the reviewer, and stays scoped to its branch and source',
    run: async (): Promise<void> => {
      const root = await mkdtemp(join(tmpdir(), 'malt-understanding-'));
      const current = snapshot('feature/queue', source);
      const file = current.nodes.find((n) => n.kind === 'file');
      assert.ok(file !== undefined);
      const module = { path: file.path, purpose: analysis.what, exports: ['enqueue'], understanding: analysis };
      const modules = groundModules([module], [{ path: file.path, content: source }]);
      const human = 'Batching preserves enqueue order during reconnect.';
      try {
        await saveScan(root, current.branch, modules, () => true);
        const first = await withUnderstanding(root, current);
        assert.equal(first.nodes.find((n) => n.kind === 'file')?.tags.includes('needs clarification'), true);
        await saveNote(root, { branch: current.branch, file }, { ...ground(analysis, source), confirmed: human }, () => true);
        await saveScan(root, current.branch, modules, () => true);
        const saved = await withUnderstanding(root, current);
        assert.equal(saved.nodes.find((n) => n.kind === 'file')?.tags.includes('developer clarified'), true);
        await saveMapFile(root, 'reviewer.json', reviewerMap(saved), () => true);
        assert.equal((await loadArchitecture(root)).modules[0]?.understanding?.confirmed, human);
        for (const different of [snapshot('main', source), snapshot(current.branch, source.replace('push(1)', 'push(2)'))]) {
          const changed = await withUnderstanding(root, different);
          assert.equal(changed.nodes.some((n) => n.understanding !== undefined), false);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  },
];
