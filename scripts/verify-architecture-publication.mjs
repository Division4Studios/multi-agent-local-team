/** Public entry points, preservation of previously delivered files, and real Chrome in CI. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from '../bin/malt-diagram.mjs';
import { browserCheck } from '../bin/publication/browser.mjs';
import { hash } from '../bin/publication/html.mjs';
import { publication } from '../out/architecture/publication.js';
import { views } from '../out/architecture/diagram.js';

const directory = mkdtempSync(join(tmpdir(), 'malt-publication-'));
const file = (name) => join(directory, name);
const write = (name, data) => {
  writeFileSync(file(name), JSON.stringify(data));
  return file(name);
};
const read = (name) => JSON.parse(readFileSync(file(name), 'utf8'));
const browser = process.argv.includes('--browser-check');
async function verify() {
  const models = [];
  for (const kind of Object.keys(views)) {
    const items = [
      { id: 'receive', label: 'Receive', group: 'Intake', start: 1000, end: 1800 },
      { id: 'write', label: 'Persist', group: 'Storage', start: 1250, end: 1700 },
    ];
    if (kind === 'tree' || kind === 'waterfall') items[1].parent = 'receive';
    if (kind === 'timeline') {
      items[0].start = Date.UTC(2026, 1, 1);
      items[1].start = Date.UTC(2026, 1, 20);
    }
    if (kind === 'classes' || kind === 'er') {
      items[0].fields = ['id bigint PRIMARY KEY'];
      items[1].fields = ['id bigint PRIMARY KEY', 'receipt_id bigint'];
    }
    const d = {
      kind,
      id: kind,
      title: 'Receipt processing',
      path: '',
      items,
      links: [{ id: 'edge', from: 'receive', to: 'write', kind: 'dependency', label: 'record', fromEnd: '0..*', toEnd: '1' }],
    };
    const model = publication(d, { paths: new Map(), locale: 'en', output: kind + '.html' });
    await command(['validate', write(kind + '.json', model)]);
    models.push(model.diagrams[0]);
  }
  const answer = {
    version: 1,
    answer: {
      title: 'Operations',
      panels: [
        { id: 'storage', title: 'Storage', body: 'First answer' },
        { id: 'web', title: 'UI', body: 'keep <script> literal text' },
      ],
    },
  };
  const input = write('answer.json', answer),
    output = file('answer.html');
  const receipt = await command(['finalize', input, output]);
  assert.equal(receipt.gates['browser-check'], 'skipped');
  assert.equal(receipt.htmlSha256, hash(readFileSync(output)));
  assert.equal(receipt.sourceSha256, hash(readFileSync(input)));
  await command(['check', input, output]);
  const prior = readFileSync(output);
  const broken = write('bad.json', { version: 1, diagrams: [{ ...models[0], items: [models[0].items[0]] }] });
  await assert.rejects(command(['finalize', broken, output]), /Unresolved/u);
  assert.deepEqual(readFileSync(output), prior);
  assert.equal(read('answer.finalize.json').gates.validate, 'fail');
  const badTime = globalThis.structuredClone(models.at(-1));
  badTime.items[0].start = '';
  await assert.rejects(command(['validate', write('bad-clock.json', { version: 1, diagrams: [badTime] })]), /start/u);
  await command([
    'patch',
    input,
    'storage',
    write('replacement.json', { id: 'storage', title: 'Storage', body: 'Revised' }),
    file('revised.html'),
  ]);
  const html = readFileSync(file('revised.html'), 'utf8');
  const restored = JSON.parse(html.match(/id="malt-source" type="application\/json">([^<]+)<\/script>/u)[1]);
  assert.equal(restored.answer.panels[0].body, 'Revised');
  assert.deepEqual(restored.answer.panels[1], answer.answer.panels[1]);
  writeFileSync(output, 'modified');
  await assert.rejects(command(['check', input, output]), /differs/u);
  const all = write('all.json', { version: 1, diagrams: models }),
    target = file('all.html');
  const failedBrowser = async () => {
    throw new Error('simulated browser launch failure');
  };
  await assert.rejects(command(['finalize', all, target], failedBrowser), /simulated/u);
  assert.equal(read('all.finalize.json').gates['browser-check'], 'fail');
  await command(['check', all, target]);
  const delta = globalThis.structuredClone(models[0]);
  delta.items.push({ id: 'audit', label: 'Audit' });
  delta.links[0].to = 'audit';
  const other = write('other.json', { version: 1, diagrams: [delta] });
  await assert.rejects(command(['compare', file('architecture.json'), other, file('diff.html')], failedBrowser), /simulated/u);
  assert.equal(read('diff.delta.json').relationships[0].type, 'rerouted');
  assert.equal(read('diff.delta.json').nodes[0].change, 'added');
  if (browser) {
    const report = await command(['finalize', all, target], (path, chrome) => browserCheck(path, chrome, true)).catch((error) => {
      console.error(read('all.finalize.json'));
      throw error;
    });
    console.log('Chrome', JSON.stringify(report.viewports));
    assert.equal(report.status, 'pass');
    assert.equal(report.htmlSha256, hash(readFileSync(target)));
    const brief = await command(['finalize', input, output, '--browser-check']);
    assert.equal(brief.gates['browser-check'], 'pass');
  }
  console.log(
    'All ten MALT diagram models, SHA-256, staged delivery, one-panel patch, tampering, branch reroute and post-delivery failure passed.',
  );
}
try {
  await verify();
} finally {
  rmSync(directory, { recursive: true, force: true });
}
