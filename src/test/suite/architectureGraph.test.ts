import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFile } from '../../architecture/extract';
import { buildGraph, compareGraphs } from '../../architecture/graph';
import type { ArchitectureGraph, Snapshot } from '../../architecture/graph';
import { loadRevision, saveSnapshot } from '../../architecture/storage';
import type { TestCase } from './harness';

const base = extractFile('ui/base.tsx', 'export class Widget {}\nexport function paint() { return 1; }\nexport function Badge() { return null; }');
const widget = [
  "import { Widget, paint as draw, Badge } from './base';",
  'export class Button extends Widget {',
  '  render() {',
  '    draw();',
  '    return <Badge />;',
  '  }',
  '}',
].join('\n');
const graphOf = (source: string): ArchitectureGraph => buildGraph([base, extractFile('ui/button.tsx', source)]);
const names = (graph: ArchitectureGraph): string[] => {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n.label]));
  return graph.edges.map((edge) => `${nodes.get(edge.from) ?? '?'} ${edge.kind} ${nodes.get(edge.to) ?? '?'}`);
};

export const tests: readonly TestCase[] = [
  {
    name: 'architecture explorer: source-backed hierarchy, aliased call, inheritance, and JSX composition',
    run: (): void => {
      const graph = graphOf(widget);
      assert.deepEqual(names(graph), ['button.tsx imports base.tsx', 'Button inherits Widget', 'render calls paint', 'render renders Badge']);
      const render = graph.nodes.find((n) => n.label === 'render');
      assert.equal(render?.line, 3);
      assert.equal(render.parent, graph.nodes.find((n) => n.label === 'Button')?.id);
      assert.ok(render.tags.includes('UI'));
    },
  },
  {
    name: 'architecture explorer: C# brace-on-next-line methods and class/interface relationships',
    run: (): void => {
      const graph = buildGraph([
        extractFile('api/Base.cs', 'public class Base {}'),
        extractFile('api/IView.cs', 'public interface IView {}'),
        extractFile('api/View.cs', 'class View : Base, IView\n{\n  public void Refresh()\n  {\n    this.Draw();\n  }\n  public void Draw() {}\n}'),
      ]);
      assert.deepEqual(names(graph), ['View inherits Base', 'View implements IView', 'Refresh calls Draw']);
    },
  },
  {
    name: 'architecture explorer: Python relative imports, indentation and guarded ambiguity',
    run: (): void => {
      const graph = buildGraph([
        extractFile('ui/base.py', 'class Widget:\n    pass\ndef save():\n    pass'),
        extractFile('ui/other.py', 'class Widget:\n    pass'),
        extractFile('ui/view.py', 'from .base import Widget, save as persist\nclass View(Widget):\n    def run(self):\n        persist()\n# persist()'),
        extractFile('ui/unknown.py', 'class Unknown(Widget):\n    pass'),
      ]);
      assert.deepEqual(names(graph), ['view.py imports base.py', 'View inherits Widget', 'run calls save']);
    },
  },
  {
    name: 'architecture explorer: changed relationships and ancestors, removed source, stable line-shift identity',
    run: (): void => {
      const before = graphOf(widget);
      const after = graphOf(widget.replace('    draw();', '    // draw();').replace('export class Button', '\nexport class Button'));
      const diff = compareGraphs(after, before);
      assert.equal(diff.edges.find((e) => e.kind === 'calls')?.status, 'removed');
      assert.equal(diff.edges.find((e) => e.kind === 'renders')?.status, 'same');
      assert.equal(diff.nodes.find((n) => n.label === 'ui')?.status, 'changed');
      const shifted = compareGraphs(graphOf(`\n${widget}`), before);
      assert.equal(shifted.nodes.find((n) => n.label === 'render')?.status, 'same');
      const removed = compareGraphs(buildGraph([base]), before);
      assert.equal(removed.nodes.find((n) => n.label === 'Button')?.status, 'removed');
      const added = compareGraphs(before, buildGraph([base]));
      assert.equal(added.nodes.find((n) => n.label === 'Button')?.status, 'added');
    },
  },
  {
    name: 'architecture storage: slash branches stay separate, stale writes discard, and pinned snapshots round-trip',
    run: async (): Promise<void> => {
      const root = await mkdtemp(join(tmpdir(), 'malt-map-'));
      const snapshot: Snapshot = { ...graphOf(widget), version: 1, commit: 'a'.repeat(40), branch: 'feature/ui', generatedAt: '', skipped: 0 };
      try {
        await saveSnapshot(root, 'branch', snapshot, () => true);
        await saveSnapshot(root, 'branch', { ...snapshot, branch: 'feature-ui' }, () => true);
        await saveSnapshot(root, 'branch', { ...snapshot, branch: 'feature/obsolete' }, () => false);
        await saveSnapshot(root, 'commit', snapshot, () => true);
        assert.deepEqual(await loadRevision(root, snapshot.commit), snapshot);
        const dir = join(root, '.malt/maps/v1');
        const entries = await readdir(dir);
        assert.equal(entries.filter((f) => f.startsWith('branch-')).length, 2);
        assert.equal(entries.some((f) => f.endsWith('.tmp')), false);
        assert.equal(await readFile(join(dir, '.gitignore'), 'utf8'), '*\n');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'architecture storage: rejects a linked output directory',
    run: async (): Promise<void> => {
      const root = await mkdtemp(join(tmpdir(), 'malt-map-link-'));
      try {
        const outside = join(root, 'outside');
        const workspace = join(root, 'work');
        await mkdir(outside);
        await mkdir(workspace);
        await symlink(outside, join(workspace, '.malt'), 'junction');
        await assert.rejects(saveSnapshot(workspace, 'branch', { ...graphOf(widget), version: 1, commit: '', branch: 'dev', generatedAt: '', skipped: 0 }, () => true));
        assert.deepEqual(await readdir(outside), []);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  },
];
