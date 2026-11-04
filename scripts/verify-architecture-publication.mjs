/** Integration against a separately installed, pinned Archify CLI. CI runs a real Chrome check on the delivered file. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { publication, publicationKind } from '../out/architecture/publication.js';
import { views } from '../out/architecture/diagram.js';

const cli = resolve(process.argv[2]),
  directory = mkdtempSync(join(tmpdir(), 'malt-publication-'));
const generate = process.argv.includes('--generate-only');
console.log(directory);
const run = (args) => {
  const out = spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: 'utf8', maxBuffer: 8_000_000 });
  if (out.error) {
    throw out.error;
  }
  assert.equal(out.status, 0, `${args.join(' ')}\n${out.stderr}\n${out.stdout.slice(0, 6500)}`);
};
for (const kind of Object.keys(views)) {
  const items = [
    { id: 'receive', label: 'Receive', group: 'Intake', start: 1000, end: 1800 },
    { id: 'write', label: 'Persist', group: 'Storage', start: 1250, end: 1700 },
  ];
  if (kind === 'tree' || kind === 'waterfall') {
    items[1].parent = 'receive';
  }
  if (kind === 'timeline') {
    items[0].start = Date.UTC(2026, 1, 1);
    items[1].start = Date.UTC(2026, 1, 20);
  }
  if (kind === 'er' || kind === 'classes') {
    items[0].fields = ['id bigint PRIMARY KEY'];
    items[1].fields = ['id bigint PRIMARY KEY', 'receipt_id bigint'];
  }
  const d = {
    kind,
    id: kind,
    title: 'Receipt processing',
    path: '',
    items,
    links: [{ from: 'receive', to: 'write', kind: 'dependency', label: 'record', fromEnd: '0..*', toEnd: '1' }],
  };
  const input = join(directory, kind + '.json'),
    output = join(directory, kind + '.html'),
    type = publicationKind(d);
  writeFileSync(input, JSON.stringify(publication(d, { paths: new Map(), locale: 'en', output: kind + '.html' })));
  if (generate) {
    continue;
  }
  run(['validate', type, input]);
  if (kind === 'waterfall') {
    const receipt = join(directory, 'waterfall.finalize.json');
    run([
      'finalize',
      type,
      input,
      output,
      '--receipt',
      receipt,
      ...(process.argv.includes('--browser-check') ? ['--browser-check'] : []),
    ]);
    const hash = createHash('sha256').update(readFileSync(output)).digest('hex');
    assert.ok(readFileSync(receipt, 'utf8').includes(hash), 'receipt binds the exact delivered HTML');
    console.log('Delivered HTML SHA-256', hash, 'receipt', receipt);
  }
  console.log(type, 'validated');
}
