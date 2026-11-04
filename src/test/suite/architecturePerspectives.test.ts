import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { evidenceDiagrams } from '../../architecture/evidence';
import { extractFile } from '../../architecture/extract';
import { buildGraph } from '../../architecture/graph';
import { parseDiagram } from '../../architecture/diagram';
import { infrastructure } from '../../architecture/infrastructure';
import { publishGuidance, readGuidance, shareHandoff, guidanceFeed } from '../../architecture/guidance';
import { feedVerifier } from '../../architecture/feedSignature';
import { catalog, related } from '../../architecture/catalog';
import { publication } from '../../architecture/publication';
import type { TestCase } from './harness';

export const tests: TestCase[] = [
  {
    name: 'SQL columns, nullable and unique FK ends and transfers retain shared table identities',
    run: (): void => {
      const ds = evidenceDiagrams(
        'db/migration.sql',
        [
          'CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR(200) UNIQUE);',
          'CREATE TABLE ledger (id INTEGER PRIMARY KEY, owner INTEGER NOT NULL UNIQUE REFERENCES users(id), amount DECIMAL(10,2));',
          'CREATE TABLE audit (owner INT REFERENCES users(id));',
          'INSERT INTO ledger SELECT * FROM users;',
        ].join('\n'),
      );
      const er = ds.find((d) => d.kind === 'er'),
        flow = ds.find((d) => d.kind === 'dataflow');
      assert.ok(er !== undefined && flow !== undefined);
      assert.equal(er.items[1]?.fields?.length, 3);
      assert.deepEqual(
        er.links.map((l) => [l.fromEnd, l.toEnd]),
        [
          ['0..1', '1'],
          ['0..*', '0..1'],
        ],
      );
      const users = er.items[0];
      assert.ok(users !== undefined);
      assert.equal(related(ds, er, users)[0]?.item.ref, 'table:users');
    },
  },
  {
    name: 'workflow steps and dependencies, Mermaid retry and measured spans are separate forms of evidence',
    run: (): void => {
      const flow = evidenceDiagrams(
        '.github/workflows/ci.yml',
        'jobs:\n  build:\n    steps:\n      - name: Compile\n  deploy:\n    needs: [build]\n    steps:\n      - name: Publish',
      )[0];
      assert.equal(
        flow?.links.some((l) => l.from === 'build/1' && l.to === 'deploy' && l.label === 'needs'),
        true,
      );
      const life = evidenceDiagrams('jobs.mmd', 'stateDiagram-v2\n[*] --> Ready\nReady --> Ready : retry\nReady --> [*]')[0];
      assert.ok(life !== undefined);
      assert.ok(life.links.some((l) => l.kind === 'retry'));
      assert.equal(life.items.length, 3);
      const trace = evidenceDiagrams(
        'run.trace.json',
        JSON.stringify({
          traceEvents: [
            { ph: 'X', name: 'request', ts: 0, dur: 5000, tid: 1 },
            { ph: 'X', name: 'write', ts: 1000, dur: 2000, tid: 1 },
            { ph: 'X', name: 'parallel', ts: 1000, dur: 3000, tid: 2 },
          ],
        }),
      )[0];
      assert.equal(trace?.items.find((i) => i.label === 'write')?.parent, '0');
      assert.equal(trace.items.find((i) => i.label === 'parallel')?.parent, undefined);
      assert.equal(trace.items.find((i) => i.label === 'request')?.end, 5);
    },
  },
  {
    name: 'domain-specific roles, observed calls, class members and owned fields are navigable across perspectives',
    run: (): void => {
      const source =
        'export class Ledger {}\nexport class Wallet {\n  private ledger = new Ledger();\n  pay() {\n    store();\n    store();\n  }\n}\nfunction store() {}\n';
      const graph = buildGraph([extractFile('wallet.ts', source)]);
      const snapshot = { ...graph, version: 1 as const, branch: 'dev', commit: '', generatedAt: '', skipped: 0 };
      const ds = catalog(snapshot);
      assert.equal(
        ds.find((d) => d.kind === 'classes')?.links.some((l) => l.kind === 'composition'),
        true,
      );
      const seq = ds.find((d) => d.kind === 'sequence' && d.title.startsWith('pay'));
      assert.equal(seq?.links.length, 2);
      const part = seq.items[0];
      assert.ok(part !== undefined);
      assert.ok(related(ds, seq, part).some((r) => r.model.kind === 'tree'));
      const infra = infrastructure(
        'compose.yaml',
        'services:\n  api:\n    depends_on: [db]\n    environment:\n      PASSWORD: hidden\n  db:\n    image: postgres',
      )[0];
      assert.ok(infra !== undefined);
      assert.equal(infra.links[0]?.to, 'db');
      assert.ok(!JSON.stringify(infra).includes('hidden'));
    },
  },
  {
    name: 'blank timestamps reject the model and publication refuses a dangling relationship',
    run: (): void => {
      const base = {
        id: 'a',
        kind: 'timeline',
        title: 'Events',
        path: '',
        items: [{ id: 'e', label: 'event', start: '' }],
        links: [],
      };
      assert.equal(parseDiagram(base), undefined);
      const d = parseDiagram({ ...base, items: [{ id: 'e', label: 'event', start: '2026-11-04T10:00:00-05:00' }] });
      assert.ok(d !== undefined);
      assert.equal(d.items[0]?.start, Date.UTC(2026, 10, 4, 15));
      d.links.push({ from: 'e', to: 'missing', label: 'bad' });
      assert.throws(() => publication(d, { locale: 'en', paths: new Map() }), /unresolved/u);
    },
  },
  {
    name: 'sessions share a revision, reject stale handoffs and refuse forged developer guidance',
    run: async (): Promise<void> => {
      const root = await mkdtemp(join(tmpdir(), 'malt-guidance-'));
      try {
        const key = randomBytes(32),
          verifier = feedVerifier(key);
        const s = { ...buildGraph([]), version: 1 as const, branch: 'dev', commit: 'abc', generatedAt: '', skipped: 0 };
        await publishGuidance(root, s, key, () => true);
        const first = await readGuidance(root, verifier),
          before = await guidanceFeed(root, verifier);
        await shareHandoff(root, verifier, { revision: first.revision, agent: 'worker A', message: 'Trace the\u202Estorage path.' });
        const after = await guidanceFeed(root, verifier);
        assert.notEqual(after.cursor, before.cursor);
        assert.doesNotMatch(JSON.stringify(after.content), /\u202e/u);
        assert.match(JSON.stringify(after.content), /worker A/u);
        await publishGuidance(root, { ...s, branch: 'feature' }, key, () => true);
        assert.doesNotMatch(JSON.stringify((await guidanceFeed(root, verifier)).content), /worker A/u);
        await assert.rejects(shareHandoff(root, verifier, { revision: first.revision, agent: 'B', message: 'stale' }), /changed/u);
        const file = join(root, '.malt/maps/v1/guidance.json');
        await writeFile(file, (await readFile(file, 'utf8')).replace('feature', 'forged'));
        await assert.rejects(readGuidance(root, verifier), /signature/u);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  },
];
