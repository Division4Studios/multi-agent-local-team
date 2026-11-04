import assert from 'node:assert/strict';
import test from 'node:test';

// Exercise the shipped webview script's event contract without starting an editor or acquiring credentials.
class Element extends globalThis.EventTarget {
  children = [];
  attributes = new Map();
  value = '';
  textContent = '';
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  click() { this.dispatchEvent(new globalThis.Event('click')); }
  text() { return [this.textContent, ...this.children.map(child => child.text())].join(' '); }
}
const node = (id, parent, label, kind, path, line) => ({ id, parent, label, kind, path, line, tags: ['UI'], status: 'same' });

test('architecture view drills down, traces one diff side, opens evidence and seeds a clarification', async t => {
  const host = new globalThis.EventTarget(), elements = new Map(), messages = [];
  const element = id => {
    if (!elements.has(id)) { elements.set(id, new Element()); }
    return elements.get(id);
  };
  host.origin = 'vscode-webview://architecture-test';
  host.acquireVsCodeApi = () => ({ postMessage: msg => messages.push(msg) });
  const document = { getElementById: element, createElement: () => new Element(), createElementNS: () => new Element(),
    createTextNode: text => Object.assign(new Element(), { textContent: text }) };
  globalThis.window = host;
  globalThis.document = document;
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  await import('../../media/architecture.js');
  assert.equal(messages.at(-1).action, 'ready');
  const path = 'ui/widget.tsx';
  const file = node('file:' + path, 'dir:ui', 'widget.tsx', 'file', path, 1);
  file.understanding = { what: 'Draws the badge.', whatEvidence: 'draw()', why: 'Possibly a fallback.', whyEvidence: '', question: 'Why draw here?' };
  const nodes = [node('workspace', '', 'Project', 'project', '', 0), node('dir:ui', 'workspace', 'ui', 'folder', 'ui', 0),
    file, node('w', file.id, 'Widget', 'class', path, 2), node('d', file.id, 'draw', 'function', path, 5)];
  const edges = [{ from: 'w', to: 'd', kind: 'calls', status: 'added', line: 3 }];
  const render = (diff, origin = host.origin) => host.dispatchEvent(new globalThis.MessageEvent('message', { origin,
    data: { action: 'graph', title: 'Widget project', message: 'Ready', diff, graph: { nodes, edges } } }));
  const select = label => {
    const card = element('map').children.find(child => child.attributes.get('aria-label')?.split(' · ').includes(label));
    assert.ok(card, label);
    card.click();
  };
  render(false, 'https://untrusted.invalid');
  assert.equal(element('map').children.length, 0);
  render(false);
  for (const label of ['ui', 'widget.tsx', 'Widget']) { select(label); }
  element('traceStart').click();
  select('draw');
  element('traceEnd').click();
  assert.match(element('trail').text(), /calls/);
  element('source').click();
  assert.deepEqual(messages.at(-1), { action: 'source', id: 'd' });
  element('knowledge').children.at(-1).click();
  assert.deepEqual(messages.at(-1), { action: 'clarify', id: 'd' });
  render(true);
  element('traceSide').value = 'base';
  element('traceSide').dispatchEvent(new globalThis.Event('change'));
  assert.match(element('trail').text(), /No resolved directed path/);
  element('search').value = 'draw';
  element('search').dispatchEvent(new globalThis.Event('input'));
  assert.match(element('matches').text(), /1 matches/);
  element('compare').click();
  assert.equal(messages.at(-1).action, 'compare');
});
