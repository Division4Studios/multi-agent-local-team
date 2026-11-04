import '../../media/perspectiveDrawing.js';
import { requireValue } from './model.mjs';

export const escape = (v) =>
  String(v).replace(/[&<>"']/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
class Element {
  constructor(type) {
    this.type = type;
    this.attrs = {};
    this.children = [];
    this.textContent = '';
    this.ownerDocument = { createElementNS: (_, name) => new Element(name) };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  append(child) {
    this.children.push(child);
  }
  replaceChildren() {
    this.children = [];
  }
  addEventListener() {}
  serialize() {
    const attrs = Object.entries(this.attrs)
      .map(([k, v]) => ' ' + k + '="' + escape(v) + '"')
      .join('');
    return (
      '<' +
      this.type +
      attrs +
      '>' +
      escape(this.textContent) +
      this.children.map((c) => c.serialize()).join('') +
      '</' +
      this.type +
      '>'
    );
  }
}
const number = (a, k) => Number(a[k]);
function rect(a) {
  return { x: number(a, 'x'), y: number(a, 'y'), w: number(a, 'width'), h: number(a, 'height') };
}
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function segments(shape) {
  const a = shape.attrs;
  if (shape.type === 'line') return [[number(a, 'x1'), number(a, 'y1'), number(a, 'x2'), number(a, 'y2')]];
  const tokens = a.d.trim().split(/\s+/u);
  requireValue(tokens.shift() === 'M', 'Unknown relationship path');
  let x = Number(tokens.shift()),
    y = Number(tokens.shift());
  const parts = [];
  while (tokens.length) {
    const command = tokens.shift(),
      v = Number(tokens.shift());
    requireValue(Number.isFinite(v) && ['h', 'v', 'H', 'V'].includes(command), 'Non-orthogonal relationship');
    const nx = command === 'H' ? v : command === 'h' ? x + v : x,
      ny = command === 'V' ? v : command === 'v' ? y + v : y;
    if (x !== nx || y !== ny) parts.push([x, y, nx, ny]);
    x = nx;
    y = ny;
  }
  return parts;
}
const within = (v, a, b) => v > Math.min(a, b) && v < Math.max(a, b);
function crossing(a, b) {
  const [x, y, x2, y2] = a,
    [u, v, u2, v2] = b;
  if (y === y2 && u === u2) return within(u, x, x2) && within(y, v, v2);
  if (x === x2 && v === v2) return within(v, y, y2) && within(x, u, u2);
  return false;
}
function enters([x, y, x2, y2], r) {
  return y === y2
    ? within(y, r.y, r.y + r.h) && Math.max(Math.min(x, x2), r.x) < Math.min(Math.max(x, x2), r.x + r.w)
    : within(x, r.x, r.x + r.w) && Math.max(Math.min(y, y2), r.y) < Math.min(Math.max(y, y2), r.y + r.h);
}
function geometry(svg, d) {
  const cards = svg.children
    .filter((c) => c.attrs['data-item'] !== undefined)
    .map((c) => ({ id: c.attrs['data-item'], ...rect(c.children.find((n) => n.type === 'rect').attrs) }));
  const wires = svg.children
    .filter((c) => c.attrs['data-wire'] !== undefined)
    .map((c) => ({ link: d.links[Number(c.attrs['data-wire'])], parts: segments(c) }));
  const labels = svg.children
    .filter((c) => c.attrs.class === 'edge-label')
    .map((c) => ({ x: number(c.attrs, 'x'), y: number(c.attrs, 'y') - 10, w: 6 * c.textContent.length, h: 11 }));
  requireValue(
    cards.every((c) => [c.x, c.y, c.w, c.h].every(Number.isFinite)) &&
      [svg.attrs.width, svg.attrs.height].every((v) => Number.isFinite(Number(v))),
    'Invalid SVG extent',
  );
  for (const [i, c] of cards.entries())
    requireValue(!cards.slice(i + 1).some((other) => overlaps(c, other)), 'Overlapping cards: ' + c.id);
  for (const [i, a] of wires.entries()) {
    for (const part of a.parts) {
      requireValue(!cards.some((c) => enters(part, c)), 'Route enters a card: ' + a.link.from + ' → ' + a.link.to);
      requireValue(!labels.some((l) => enters(part, l)), 'Route enters a relationship label: ' + a.link.label);
      requireValue(!wires.slice(i + 1).some((b) => b.parts.some((p) => crossing(part, p))), 'Relationship crossing: ' + a.link.label);
    }
  }
  for (const [i, l] of labels.entries()) {
    requireValue(
      !cards.some((c) => overlaps(l, c)) && !labels.slice(i + 1).some((b) => overlaps(l, b)),
      'Relationship label clearance',
    );
  }
  return { view: d.kind, id: d.id, cards: cards.length, routes: wires.length, labels: labels.length };
}
export function renderDiagram(d, selected) {
  const svg = new Element('svg');
  svg.setAttribute('id', 'modelSvg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  globalThis.drawMaltPerspective(svg, d, d.items, () => {}, { selected, zoom: 1, fields: true, zone: 'UTC' });
  return { markup: svg.serialize(), geometry: geometry(svg, d) };
}
