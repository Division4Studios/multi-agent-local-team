import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDiagram } from '../../bin/publication/geometry.mjs';

class Element extends globalThis.EventTarget {
  children = [];
  attrs = new Map();
  textContent = '';
  constructor(type, document) { super(); this.type = type; this.ownerDocument = document; }
  setAttribute(key, value) { this.attrs.set(key, String(value)); }
  getAttribute(key) { return this.attrs.get(key); }
  append(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
}
const draw = (diagram, fields = false) => {
  const document = { createElementNS: (_, type) => new Element(type, document) };
  const svg = new Element('svg', document);
  globalThis.drawMaltPerspective(svg, diagram, diagram.items, () => {}, { zoom: 1, fields, zone: 'UTC' });
  return svg;
};
const cards = (svg) => svg.children.filter((child) => child.attrs.has('data-item'));
const texts = (card) => card.children.filter((child) => child.type === 'text');
const fixture = (kind) => ({
  id: kind, kind, title: 'Order processing', path: 'src/order.ts',
  items: [
    { id: 'api', label: 'CheckoutRequestHandler', group: 'Service', summary: 'Checks the order and sends a payment request to the payment provider.', start: 0, end: 100 },
    { id: 'store', label: 'OrderRepository', group: 'Storage', summary: 'Stores the confirmed order so the customer can find it later.', start: 25, end: 70 },
  ],
  links: [{ from: 'api', to: 'store', label: 'Save confirmed order', kind: 'dependency' }],
});

test('sequence headers include wrapped responsibilities above every message', () => {
  const diagram = fixture('sequence');
  diagram.items[0].label = 'AQuiteLongParticipantNameThatMustRemainAvailableWithoutEllipsis';
  diagram.items[0].summary = 'Checks <script>literal text</script> in a request before sending a payment request to the provider.';
  diagram.links[0].label = 'A detailed message explaining what the sender asks the receiving service to do before confirming the order';
  const svg = draw(diagram), headerCards = cards(svg);
  assert.equal(headerCards.length, 2);
  for (const card of headerCards) {
    const box = card.children.find((child) => child.type === 'rect');
    const title = texts(card).filter((line) => line.getAttribute('class') === 'card-title').map((line) => line.textContent).join('');
    assert.equal(title, diagram.items.find((item) => item.id === card.getAttribute('data-item')).label);
    assert.ok(texts(card).some((line) => line.getAttribute('class') === 'card-summary'));
    assert.ok(texts(card).every((line) => !line.textContent.includes('…')));
    assert.ok(texts(card).every((line) => Number(line.getAttribute('y')) < Number(box.getAttribute('y')) + Number(box.getAttribute('height'))));
  }
  assert.ok(texts(headerCards[0]).map((line) => line.textContent).join(' ').includes('<script>literal text</script>'));
  assert.ok(svg.children.filter((child) => child.getAttribute('class') === 'edge-label').length > 1, 'long messages wrap as well');
  assert.doesNotThrow(() => renderDiagram(diagram), 'richer sequence headers still pass portable geometry validation');
});

test('class cards separate responsibility, attributes and operations without shortening signatures', () => {
  const diagram = fixture('classes');
  diagram.items[0].group = 'interface';
  diagram.items[0].fields = ['readonly orderId: string;', 'handler: (order: Order) => Promise<void>;', 'submit(order: Order, options: SubmissionOptions): Promise<PaymentResult>;', 'private store = new Repository();'];
  const detailed = cards(draw(diagram, true))[0];
  const visible = texts(detailed).map((line) => line.textContent);
  assert.equal(visible[0], '«interface»');
  assert.ok(visible.indexOf('Attributes') > visible.findIndex((line) => line.includes('Checks the order')));
  assert.ok(visible.indexOf('Operations') > visible.indexOf('Attributes'));
  assert.ok(visible.slice(visible.indexOf('Attributes'), visible.indexOf('Operations')).some((line) => line.startsWith('handler:')));
  assert.match(visible.slice(visible.indexOf('Operations')).join(' '), /submit\(order: Order, options: SubmissionOptions\): Promise<PaymentResult>/u);
  assert.equal(detailed.children.filter((child) => child.getAttribute('class') === 'compartment-rule').length, 2);
  const summary = texts(cards(draw(diagram))[0]).map((line) => line.textContent).join(' ');
  assert.doesNotMatch(summary, /orderId|submit\(|Attributes|Operations/u, 'member details are hidden in summary mode');
  assert.match(summary, /Checks the order/u);
  assert.doesNotThrow(() => renderDiagram(diagram));
});

test('all ten layouts embed explanations and remain valid for portable delivery', () => {
  for (const kind of ['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle', 'er', 'classes', 'tree', 'timeline', 'waterfall']) {
    const diagram = fixture(kind);
    if (kind === 'tree') { diagram.items[1].parent = 'api'; }
    const svg = draw(diagram);
    for (const card of cards(svg)) {
      const body = texts(card).filter((line) => line.getAttribute('class') === 'card-summary').map((line) => line.textContent).join(' ');
      assert.equal(body, diagram.items.find((item) => item.id === card.getAttribute('data-item')).summary, kind);
    }
    assert.doesNotThrow(() => renderDiagram(diagram), kind);
  }
});

test('paths do not masquerade as explanations and unannotated participants get structural context', () => {
  const diagram = fixture('sequence');
  delete diagram.items[0].summary;
  diagram.items[0].detail = 'src/checkout/handler.ts';
  const body = texts(cards(draw(diagram))[0]).filter((line) => line.getAttribute('class') === 'card-summary').map((line) => line.textContent).join(' ');
  assert.equal(body, 'Sends 1 and receives 0 messages in this exchange.');
  diagram.items[0].detail = 'Accepts customer orders after validating their contents.';
  const explained = texts(cards(draw(diagram))[0]).filter((line) => line.getAttribute('class') === 'card-summary').map((line) => line.textContent).join(' ');
  assert.equal(explained, diagram.items[0].detail);
});

test('connection labels stay inside the drawing for long chains and crowded fan-outs', () => {
  const node = (id) => ({ id, label: 'Node ' + id, summary: 'Handles step ' + id });
  const chainItems = Array.from({ length: 21 }, (_, i) => node('c' + String(i)));
  const chain = { id: 'chain', kind: 'dataflow', title: 'Chain', path: 'src/a.ts', items: chainItems,
    links: chainItems.slice(1).map((item, i) => ({ from: chainItems[i].id, to: item.id, label: 'passes data ' + String(i), kind: 'dependency' })) };
  const sinks = Array.from({ length: 30 }, (_, i) => node('s' + String(i)));
  const fan = { id: 'fan', kind: 'dataflow', title: 'Fan-out', path: 'src/a.ts', items: [node('hub'), ...sinks],
    links: sinks.map((item, i) => ({ from: 'hub', to: item.id, label: 'feeds ' + String(i), kind: 'dependency' })) };
  for (const diagram of [chain, fan]) {
    const svg = draw(diagram);
    const [, , , height] = svg.getAttribute('viewBox').split(' ').map(Number);
    const labels = svg.children.filter((child) => child.getAttribute('class') === 'edge-label');
    assert.equal(labels.length, diagram.links.length, diagram.id + ': every connection is labelled');
    assert.ok(labels.every((label) => Number(label.getAttribute('y')) >= 11 && Number(label.getAttribute('y')) <= height), diagram.id + ': no label leaves the viewBox');
    assert.doesNotThrow(() => renderDiagram(diagram), diagram.id + ': portable geometry accepts it');
  }
});
