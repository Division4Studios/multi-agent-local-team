import assert from 'node:assert/strict';
import test from 'node:test';

class Element extends globalThis.EventTarget {
  children = [];
  attributes = new Map();
  textContent = '';
  value = '';
  checked = false;
  disabled = false;
  constructor(document) { super(); this.ownerDocument = document; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) {
    if (this.children.some(child => child.contains(this.ownerDocument.activeElement))) { this.ownerDocument.activeElement = undefined; }
    this.children = items;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  click() { if (!this.disabled) { this.dispatchEvent(new globalThis.Event('click')); } }
  text() { return [this.textContent, ...this.children.map(child => child.text())].join(' '); }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
  contains(node) { return this.all().includes(node); }
  querySelectorAll(selector) { return this.all().filter(node => node.attributes.has(selector.slice(1, -1))); }
  focus() { this.ownerDocument.activeElement = this; }
}

test('perspectives play ordered messages, pause, step, reset, and stop on terminal selections', async t => {
  const document = new globalThis.EventTarget(), elements = new Map(), timers = new Map(), sent = [];
  document.getElementById = id => {
    if (!elements.has(id)) { elements.set(id, new Element(document)); }
    return elements.get(id);
  };
  document.createElement = document.createElementNS = () => new Element(document);
  const el = document.getElementById;
  let timerId = 0;
  const host = { matchMedia: () => ({ matches: false }), setInterval: fn => { timers.set(++timerId, fn); return timerId; }, clearInterval: id => timers.delete(id) };
  globalThis.document = document; globalThis.window = host;
  t.after(() => { delete globalThis.document; delete globalThis.window; delete globalThis.drawMaltPerspective; delete globalThis.maltPalette; });
  await import('../../media/perspectiveDrawing.js');
  host.drawMaltPerspective = globalThis.drawMaltPerspective;
  host.maltPalette = globalThis.maltPalette;
  await import('../../media/perspectives.js');
  el('modelSpeed').value = '950'; el('modelFields').checked = true;
  const receive = host.startMaltViews(message => sent.push(message), () => undefined);
  const model = { id: 'messages', kind: 'sequence', path: 'flow.json', items: ['a', 'b', 'c'].map(id => ({ id, label: id.toUpperCase(), group: 'Service' })), links: [
    { from: 'a', to: 'b', label: 'Request' }, { from: 'b', to: 'a', label: 'Reply', kind: 'return' }, { from: 'a', to: 'c', label: 'Notify' },
  ] };
  const state = { model, place: { kind: 'sequence', key: 'messages', item: '' }, kinds: [['sequence', 'Sequence']], related: [], menu: [], side: 'target' };
  receive(state);
  assert.equal(el('modelSvg').getAttribute('data-motion'), 'still');
  el('modelPlay').click();
  assert.equal(sent.at(-1).item, 'b');
  assert.match(el('modelRoute').text(), /Step 1 of 3: A → B · Request/);
  const beforeSpeedChange = sent.length;
  el('modelSpeed').value = '1800';
  el('modelSpeed').dispatchEvent(new globalThis.Event('change'));
  assert.equal(sent.length, beforeSpeedChange, 'changing speed does not skip ahead');
  assert.equal(timers.size, 1, 'changing speed replaces the active timer');
  el('modelPlay').click();
  assert.equal(timers.size, 0, 'pause clears the timer immediately');
  el('modelStep').click();
  assert.equal(sent.at(-1).item, 'a', 'return is played before the next outgoing request');
  assert.ok(el('modelSvg').all().some(node => node.getAttribute('data-wire') === '1' && node.getAttribute('data-active') === 'true'));
  const routeStep = el('modelSteps').children[1].children[0];
  routeStep.focus();
  routeStep.click();
  assert.notEqual(document.activeElement, routeStep, 'the step list was rebuilt');
  assert.equal(document.activeElement?.getAttribute('data-step'), '1', 'keyboard focus stays on the selected step');
  el('modelStep').click();
  assert.equal(sent.at(-1).item, 'c');
  assert.match(el('modelRoute').text(), /Complete/);
  assert.equal(timers.size, 0);
  el('modelReset').click();
  assert.equal(el('modelSteps').children.length, 0);
  assert.equal(sent.at(-1).item, 'a', 'reset returns selection to the route start');
  assert.equal(el('modelPlay').textContent, 'Play route', 'reset clears the resume/replay label');
  assert.equal(el('modelUp').disabled, true, 'a sequence participant has no parent navigation');
  receive({ ...state, model: { ...model, kind: 'workflow' }, place: { kind: 'workflow', key: 'workflow', item: 'c' } });
  assert.equal(el('modelPlay').disabled, true, 'a terminal node cannot jump to an unrelated route');
  assert.match(el('modelRoute').text(), /No outgoing route/);
  receive({ ...state, model: undefined, place: { kind: 'er', key: '', item: '' }, empty: 'No database schema found.' });
  assert.equal(el('modelSvg').children.length, 0);
  assert.equal(el('modelPlay').disabled, true);
});
