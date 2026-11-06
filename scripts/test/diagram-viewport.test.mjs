import assert from 'node:assert/strict';
import test from 'node:test';

class Element extends globalThis.EventTarget {
  children = [];
  clientWidth = 500;
  clientHeight = 300;
  scrollLeft = 0;
  scrollTop = 0;
  attrs = new Map([['width', '800'], ['height', '400']]);
  values = new Map();
  classes = new Set();
  style = { getPropertyValue: key => this.values.get(key), setProperty: (key, value) => this.values.set(key, value) };
  classList = { add: key => this.classes.add(key), remove: key => this.classes.delete(key) };
  get scrollWidth() { return 800 + 2 * (Number.parseFloat(this.children[0]?.values.get('--pan-x')) || 0); }
  get scrollHeight() { return 400 + 2 * (Number.parseFloat(this.children[0]?.values.get('--pan-y')) || 0); }
  append(child) { this.children.push(child); }
  querySelector() { return this.svg; }
  getAttribute(key) { return this.attrs.get(key); }
  closest(selector) { return selector === '[data-item]' && this.item ? this : null; }
  focus() {}
  setPointerCapture(id) { this.pointer = id; }
  hasPointerCapture(id) { return this.pointer === id; }
  releasePointerCapture() { this.pointer = undefined; }
}
const fire = (element, type, props = {}) => {
  const event = new globalThis.Event(type, { cancelable: true });
  Object.assign(event, props);
  element.dispatchEvent(event);
  return event;
};

test('diagram panning preserves selection, supports both axes and releases capture on interruption', async t => {
  const host = new globalThis.EventTarget(), document = new globalThis.EventTarget();
  let observer;
  host.ResizeObserver = class {
    constructor(fn) { this.resize = fn; observer = this; }
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  document.createElement = () => new Element();
  globalThis.window = host; globalThis.document = document;
  t.after(() => { delete globalThis.window; delete globalThis.document; });
  await import('../../media/diagramViewport.js');
  const canvas = new Element(), center = new Element();
  canvas.svg = new Element();
  host.startMaltViewport(canvas, center);
  assert.deepEqual([canvas.scrollLeft, canvas.scrollTop], [650, 350]);
  const down = (button, extra = {}) => fire(canvas, 'pointerdown', { pointerId: 1, pointerType: 'mouse', button, clientX: 200, clientY: 160, ...extra });
  const move = (buttons, extra = {}) => fire(canvas, 'pointermove', { pointerId: 1, buttons, clientX: 260, clientY: 200, ...extra });
  canvas.item = true;
  assert.equal(down(0).defaultPrevented, false, 'normal card selection remains available');
  assert.equal(canvas.pointer, undefined);
  assert.equal(down(1).defaultPrevented, true, 'middle drag works even over a card and blocks autoscroll');
  move(4);
  assert.deepEqual([canvas.scrollLeft, canvas.scrollTop], [590, 310]);
  fire(canvas, 'pointerup', { pointerId: 1 });
  assert.equal(canvas.pointer, undefined);
  assert.equal(fire(canvas, 'auxclick', { button: 1 }).defaultPrevented, true);
  down(0);
  assert.equal(fire(canvas, 'click').defaultPrevented, false, 'card clicks still work after middle dragging');
  canvas.item = false;
  down(0); move(1); fire(canvas, 'pointerup', { pointerId: 1 });
  assert.equal(fire(canvas, 'click').defaultPrevented, true, 'primary drag does not activate a card on release');
  fire(center, 'click');
  assert.deepEqual([canvas.scrollLeft, canvas.scrollTop], [650, 350]);
  canvas.item = true;
  fire(canvas, 'keydown', { code: 'Space' });
  assert.equal(down(0).defaultPrevented, true, 'Space permits primary drag over a card');
  move(1);
  fire(canvas, 'keyup', { code: 'Space' });
  assert.equal(canvas.pointer, undefined);
  assert.equal(canvas.classes.has('pan-ready'), false);
  for (const interrupt of ['pointercancel', 'lostpointercapture']) {
    down(1); fire(canvas, interrupt, { pointerId: 1 });
    assert.equal(canvas.classes.has('is-panning'), false);
  }
  down(1); fire(host, 'blur');
  assert.equal(canvas.pointer, undefined);
  down(1); move(0);
  assert.equal(canvas.pointer, undefined, 'a lost button release does not leave a stuck drag');
  down(1); document.hidden = true; fire(document, 'visibilitychange');
  assert.equal(canvas.pointer, undefined);
  assert.equal(down(2).defaultPrevented, false);
  assert.equal(down(0, { pointerType: 'touch' }).defaultPrevented, false, 'native touch scrolling is preserved');
  fire(canvas, 'keydown', { key: 'Home' });
  fire(canvas, 'keydown', { key: 'ArrowRight' });
  assert.equal(canvas.scrollLeft, 730);
  const before = canvas.scrollLeft;
  fire(canvas, 'keydown', { key: 'ArrowLeft', ctrlKey: true });
  assert.equal(canvas.scrollLeft, before, 'browser and editor shortcuts are untouched');
  canvas.clientWidth = 600; observer.resize();
  assert.equal(canvas.scrollLeft, before + 100, 'resize preserves the current diagram offset');
  canvas.svg.attrs.set('width', '1000'); observer.resize();
  assert.equal(canvas.scrollLeft, (canvas.scrollWidth - canvas.clientWidth) / 2, 'changed diagram extents recenter');
  fire(host, 'pagehide');
  assert.equal(observer.disconnected, true);
});
