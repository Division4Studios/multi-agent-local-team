import assert from 'node:assert/strict';
import { parseInterpretation } from '../../shared/understanding';
import { ground } from '../../reviewer/understanding';
import { newDiagram, parseDiagram } from '../../shared/diagram';
import { panelQuestionContext, panelSourcePaths } from '../../architecture/panelQuestions';
import type { Snapshot } from '../../architecture/graph';
import type { TestCase } from './harness';

export const tests: readonly TestCase[] = [
  {
    name: 'scan explanations preserve participant responsibilities and qualify unsupported evidence',
    run: (): void => {
      const value = parseInterpretation({ what: 'Transfers messages.', whatEvidence: '', why: 'Purpose is unknown.', whyEvidence: '', question: '',
        explanations: [{ symbol: 'Bridge', summary: 'Carries a request from the visible page to the extension.', evidence: 'not in source', view: 'sequence', reason: 'The order of messages explains the hand-off.' }],
        claims: [{ view: 'sequence', title: 'Page requests', from: 'Page', to: 'Bridge', label: 'Select an item', evidence: 'postMessage', summary: 'A selection on screen tells the extension which item to open.', fromSummary: 'Shows the map and accepts selections.', toSummary: 'Routes the selection to the extension.' }],
      });
      assert.ok(value !== undefined);
      const checked = ground(value, 'postMessage');
      assert.equal(checked.explanations?.[0]?.evidence, '');
      assert.equal(checked.claims?.[0]?.fromSummary, 'Shows the map and accepts selections.');
      assert.equal(checked.claims[0].evidence, 'postMessage');
      assert.deepEqual(parseInterpretation({ ...value, explanations: [{ ...value.explanations?.[0], view: 'invented-view' }] })?.explanations, undefined);
    },
  },
  {
    name: 'saved diagrams retain human explanations without executing markup',
    run: (): void => {
      const diagram = newDiagram('src/bridge.ts', 'sequence', 'Page messages');
      diagram.summary = 'A request moves from the screen to the extension.';
      diagram.items = [{ id: 'page', label: 'Page', summary: '<script>not executable</script>', explanationKind: 'Working explanation' }];
      assert.deepEqual(parseDiagram(diagram), diagram);
    },
  },
  {
    name: 'panel question context remains valid bounded JSON and retains a selection beyond the first page',
    run: (): void => {
      const diagram = newDiagram('src/bridge.ts', 'classes', 'x'.repeat(2048));
      for (let index = 0; index < 90; index++) { diagram.items.push({ id: String(index), label: 'n'.repeat(2048), summary: 's'.repeat(2000), group: 'g'.repeat(500) }); }
      diagram.links = diagram.items.map((part) => ({ from: part.id, to: '0', label: 'm'.repeat(2048) }));
      const selected = { id: 'chosen', label: 'Selected beyond the first page', summary: 'Selection stays in scope.' };
      diagram.items.push(selected);
      diagram.links.push({ from: selected.id, to: '89', label: 'Relevant request from the selection' });
      const context = panelQuestionContext({ model: diagram, item: selected, snapshot: undefined }, { source: '', read: Array.from({ length: 6 }, () => 'p'.repeat(4000)), omitted: 12 });
      assert.ok(context.length <= 12_000);
      assert.doesNotThrow(() => { JSON.parse(context); });
      assert.ok(context.includes('Selection stays in scope.'));
      assert.ok(context.includes('Relevant request from the selection'));
      assert.ok(context.includes('"from":"item0"'));
      assert.ok(context.includes('"filesOmitted":12'));
    },
  },
  {
    name: 'questions include verified authored diagram paths but never arbitrary data files',
    run: (): void => {
      const diagram = newDiagram('schema.sql', 'er', 'Orders');
      diagram.items = [{ id: 'orders', label: 'Orders' }];
      const snapshot: Snapshot = { version: 1, branch: 'dev', commit: '', generatedAt: '', skipped: 0, edges: [], nodes: [
        { id: 'file:schema.sql', path: 'schema.sql', label: 'schema.sql', kind: 'file', parent: 'workspace', line: 1, tags: [], hash: 'checked-before-read' },
        { id: 'file:.env', path: '.env', label: '.env', kind: 'file', parent: 'workspace', line: 1, tags: [], hash: 'never-read' },
      ] };
      assert.deepEqual(panelSourcePaths({ model: diagram, item: diagram.items[0], snapshot }), ['schema.sql']);
      assert.deepEqual(panelSourcePaths({ model: { ...diagram, path: '.env' }, item: undefined, snapshot }), []);
    },
  },
];
