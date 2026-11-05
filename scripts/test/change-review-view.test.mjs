import assert from 'node:assert/strict';
import test from 'node:test';

class Element extends globalThis.EventTarget {
  children = []; attributes = new Map(); textContent = ''; value = ''; disabled = false;
  constructor(tag = 'div') { super(); this.tag = tag; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  get firstChild() { return this.children[0]; }
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  click() { if (!this.disabled) { this.dispatchEvent(new globalThis.Event('click')); } }
  focus() { globalThis.document.activeElement = this; }
  text() { return [this.textContent, ...this.children.map(child => child.text())].join(' '); }
}

test('before-commit view requests explanations on demand, links source and invalidates stale answers', async t => {
  const elements = new Map(), sent = [], window = new globalThis.EventTarget();
  const document = { createElement: tag => new Element(tag), getElementById: id => {
    if (!elements.has(id)) { elements.set(id, new Element()); }
    return elements.get(id);
  } };
  window.origin = 'vscode-webview://test';
  window.acquireVsCodeApi = () => ({ postMessage: message => sent.push(message) });
  globalThis.window = window; globalThis.document = document;
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  await import('../../media/changeReview.js');
  const el = document.getElementById;
  const receive = (data, origin = window.origin) => window.dispatchEvent(new globalThis.MessageEvent('message', { data, origin }));
  const packet = { files: [{ path: 'src/cart.ts', folder: 'src', name: 'cart.ts', responsibility: 'Calculates the order total.', added: 4, removed: 2,
    blocks: [{ line: 1, endLine: 4, status: 'fail', activity: 'reviewing', summary: 'Changes discounts', checks: [{ title: 'Reuse totals', status: 'fail', note: 'Duplicates totals', detail: 'Inspect both implementations.' }] }] }],
    imports: [], findings: [], counts: { failed: 1, unfinished: 0, passed: 0 } };
  const state = { type: 'state', packet, workspace: 'Shop', branch: 'dev', consolidation: 'idle' };
  receive(state);
  assert.deepEqual(sent, [{ action: 'ready' }], 'opening the panel must not call AI');
  assert.match(el('fileMap').text(), /Calculates the order total/);
  assert.match(el('findings').text(), /Duplicates totals/);
  const focusedCard = el('fileMap').querySelectorAll('button')[0];
  focusedCard.focus(); focusedCard.click();
  assert.notEqual(document.activeElement, focusedCard);
  assert.equal(document.activeElement.getAttribute('data-file'), 'src/cart.ts', 'keyboard focus stays on selected card after redraw');
  assert.match(el('queueStatus').text(), /1 blocks reviewing/);
  el('selected').querySelectorAll('button')[0].click();
  assert.deepEqual(sent.at(-1), { action: 'open', path: 'src/cart.ts' });
  el('analyze').click();
  assert.equal(sent.at(-1).action, 'ask');
  receive({ type: 'answer', question: 'What changed?', answer: { what: '<script>unsafe</script>', why: 'Likely discounts.', question: '' }, supplied: ['src/cart.ts'], omitted: 2 });
  assert.match(el('answer').text(), /<script>unsafe<\/script>/, 'untrusted output stays text');
  assert.match(el('answer').text(), /2 blocks omitted/);
  receive({ type: 'notice', text: 'foreign' }, 'https://other.test');
  assert.notEqual(el('notice').textContent, 'foreign');
  receive({ ...state, changed: true });
  assert.match(el('answer').text(), /Request a fresh explanation/);
  assert.equal(el('citations').children.length, 0);
  el('testOutcome').value = 'failed'; el('testNote').value = 'npm test: one failure'; el('recordTest').click();
  assert.deepEqual(sent.at(-1), { action: 'recordTest', outcome: 'failed', note: 'npm test: one failure' });
  receive({ ...state, verification: { outcome: 'failed', note: 'npm test: one failure' } });
  assert.match(el('testStatus').text(), /not independently verified/);
  receive({ ...state, dirty: true, changed: true });
  assert.match(el('testStatus').text(), /stale/);
  assert.equal(el('recordTest').disabled, true, 'unsaved edits cannot acquire a current test-pass claim');
  receive({ ...state, prActive: true });
  assert.equal(el('analyze').disabled, true);
});
