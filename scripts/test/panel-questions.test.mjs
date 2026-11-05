import assert from 'node:assert/strict';
import test from 'node:test';

class Element extends globalThis.EventTarget {
  children = [];
  textContent = '';
  value = '';
  disabled = false;
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  click() { if (!this.disabled) { this.dispatchEvent(new globalThis.Event('click')); } }
}

test('panel questions follow the displayed selection and ignore stale answers', async t => {
  const elements = new Map(), sent = [];
  const el = id => { if (!elements.has(id)) { elements.set(id, new Element()); } return elements.get(id); };
  globalThis.window = {};
  globalThis.document = { getElementById: el, createElement: () => new Element() };
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  await import('../../media/panelQuestions.js');
  const receive = globalThis.window.startMaltQuestions(message => sent.push(message));
  el('questionAudience').value = 'plain';
  receive({ action: 'perspective', questionKey: 'first', narration: { title: 'Bridge', summary: 'Carries page requests.', scope: 'Selected bridge' } });
  assert.equal(el('storySummary').textContent, 'Carries page requests.');
  el('askOverview').click();
  assert.equal(sent[0].key, 'first');
  assert.equal(sent[0].audience, 'plain');
  assert.equal(el('panelQuestionSend').disabled, true);
  receive({ action: 'perspective', questionKey: 'second', narration: { title: 'Page', summary: 'Accepts selections.' } });
  receive({ action: 'viewAnswer', key: 'first', phase: 'answer', answer: { what: 'Stale explanation' } });
  assert.equal(el('panelAnswer').children.length, 0);
  receive({ action: 'viewAnswer', key: 'second', phase: 'answer', answer: { what: '<img src=x onerror=bad>', why: 'Possible goal', question: 'Which users?' }, sources: [{ path: 'src/page.ts', id: 'file:src/page.ts' }], coverage: 'One source read.' });
  assert.equal(el('panelAnswer').children[1].textContent, '<img src=x onerror=bad>');
  assert.match(el('panelAnswer').children[2].textContent, /not confirmed/);
  assert.equal(el('panelQuestionSend').disabled, false);
  el('panelAnswer').children.at(-1).click();
  assert.deepEqual(sent.at(-1), { action: 'source', id: 'file:src/page.ts', key: 'second' });
});
