import assert from 'node:assert/strict';
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { deadline } from './http-helpers.mjs';
import { digestFiles, digestTree, evidenceTemp, expectedPass, expectedSecondPass, fixtureDigest,
  originalEvents, passEvent, passName, secondPassName, summaryEvent } from './evidence-fixtures.mjs';

const require = createRequire(import.meta.url);
const runtimeApi = () => require('../../../out/aws/coverage/evidence.js');
const collector = async () => (await import('../../aws-evidence-collector.mts')).createEvidenceCollector();
const copy = (value) => JSON.parse(JSON.stringify(value));
const artifact = () => ({ formatVersion: 1, runtimeDigest: fixtureDigest, cases: [copy(expectedPass)] });

test('original Node event fixture distinguishes suite skip todo expected-failure and cumulative summaries', { timeout: 8000 }, async (t) => {
  const events = await originalEvents(t);
  const passes = events.filter(({ type }) => type === 'test:pass');
  assert.ok(passes.some(({ data }) => data.name === passName && !data.skip && !data.todo));
  assert.ok(passes.some(({ data }) => data.details.type === 'suite'));
  assert.ok(passes.some(({ data }) => data.skip));
  assert.ok(passes.some(({ data }) => data.todo));
  assert.ok(passes.some(({ data }) => data.expectFailure));
  assert.ok(events.some(({ type, data }) => type === 'test:summary' && data.file !== undefined));
  const finals = events.filter(({ type, data }) => type === 'test:summary' && data.file === undefined);
  assert.equal(finals.length, 1);
  assert.equal(finals[0].data.success, true);
});

test('original Node failure fixture preserves an ordinary failure and unsuccessful final summary', { timeout: 8000 }, async (t) => {
  const events = await originalEvents(t, true);
  assert.ok(events.some(({ type, data }) => type === 'test:fail' && data.name === 'ordinary test'));
  const final = events.find(({ type, data }) => type === 'test:summary' && data.file === undefined);
  assert.equal(final.data.success, false);
  assert.ok(final.data.counts.failed > 0);
});

test('collector consumes original Node events and credits only genuine successful leaf cases in deterministic order', { timeout: 8000 }, async (t) => {
  const c = await collector();
  const events = await originalEvents(t);
  for (const event of events) {
    c.accept(event);
    if (event.type === 'test:summary' && event.data.file !== undefined) assert.equal(c.result(), undefined);
  }
  assert.deepEqual(c.result(), [expectedPass, expectedSecondPass]);
});

test('collector ordinary failure poisons an original event stream despite successful AWS-named cases', { timeout: 8000 }, async (t) => {
  const c = await collector();
  for (const event of await originalEvents(t, true)) c.accept(event);
  assert.equal(c.result(), undefined);
  c.accept(summaryEvent());
  assert.equal(c.result(), undefined, 'success cannot erase an earlier ordinary failure');
});

test('collector result requires a final cumulative summary rather than pass events or per-file summaries', async () => {
  const c = await collector();
  assert.equal(c.result(), undefined);
  c.accept(passEvent());
  assert.equal(c.result(), undefined);
  c.accept(summaryEvent({ file: '/synthetic/one.test.mjs' }));
  assert.equal(c.result(), undefined);
  c.accept(summaryEvent());
  assert.deepEqual(c.result(), [expectedPass]);
});

test('collector ignores unrelated envelopes and malformed evidence names without manufacturing operation claims', async () => {
  const c = await collector();
  for (const event of [null, {}, { type: 'test:stdout', data: { message: passName } },
    { type: 'test:diagnostic', data: { message: passName } }, { type: 'test:complete', data: { ...passEvent().data, passed: true } }]) c.accept(event);
  for (const name of ['ordinary case', 'aws[] bad', 'aws[sqs.SendMessage;unknown] bad',
    'aws[sqs;unit] bad', 'aws[.SendMessage;unit] bad', 'aws[sqs.;unit] bad',
    'aws[sqs.SendMessage,,sqs.ReceiveMessage;unit] bad', 'prefix aws[sqs.SendMessage;unit] bad']) c.accept(passEvent(name));
  c.accept(summaryEvent({ counts: { ...summaryEvent().data.counts, tests: 8, passed: 8, topLevel: 8 } }));
  assert.deepEqual(c.result(), []);
});

test('collector excludes all marked skip todo expected-failure and suite events', async () => {
  const c = await collector();
  for (const [index, marker] of [{ skip: true }, { skip: 'reason' }, { todo: true }, { todo: 'reason' },
    { expectFailure: true }, { expectFailure: 'reason' }, { details: { type: 'suite', duration_ms: 1 } }].entries()) {
    c.accept(passEvent(`aws[sqs.SendMessage;unit] excluded-${index}`, marker));
  }
  c.accept(summaryEvent({ counts: { tests: 6, passed: 2, failed: 0, cancelled: 0, skipped: 2, todo: 2, suites: 1, topLevel: 7 } }));
  assert.deepEqual(c.result(), []);
});

for (const [label, event] of [
  ['ordinary failure', { type: 'test:fail', data: { name: 'ordinary failure', details: { type: 'test', error: new Error('original failure') } } }],
  ['cancellation', { type: 'test:fail', data: { name: passName, details: { error: Object.assign(new Error('cancelled'), { failureType: 'cancelledByParent' }) } } }],
  ['interruption', { type: 'test:interrupted', data: { tests: [{ name: passName, nesting: 0 }] } }],
]) {
  test(`collector ${label} poisons an already successful summary and cannot be healed by another summary`, async () => {
    const c = await collector();
    c.accept(passEvent());
    c.accept(summaryEvent());
    assert.deepEqual(c.result(), [expectedPass]);
    c.accept(event);
    assert.equal(c.result(), undefined);
    c.accept(summaryEvent());
    assert.equal(c.result(), undefined);
  });
}

test('collector rejects duplicate case IDs as ambiguous rather than deduplicating them', async () => {
  const c = await collector();
  c.accept(passEvent());
  c.accept(passEvent(passName, { file: '/synthetic/another.test.mjs', testNumber: 2 }));
  c.accept(summaryEvent({ counts: { ...summaryEvent().data.counts, tests: 2, passed: 2, topLevel: 2 } }));
  assert.equal(c.result(), undefined);
});

test('collector sorts successful cases and operation identifiers independently of event arrival order', async () => {
  const c = await collector();
  c.accept(passEvent(secondPassName));
  c.accept(passEvent());
  c.accept(summaryEvent({ counts: { ...summaryEvent().data.counts, tests: 2, passed: 2, topLevel: 2 } }));
  assert.deepEqual(c.result(), [expectedPass, expectedSecondPass]);
});

test('collector rejects failed cancelled malformed and incomplete final summaries', async () => {
  const summaries = [null, {}, { ...summaryEvent().data, success: false }, { ...summaryEvent().data, success: 'true' },
    { ...summaryEvent().data, counts: null }, { ...summaryEvent().data, counts: {} },
    { ...summaryEvent().data, counts: { ...summaryEvent().data.counts, failed: 1 } },
    { ...summaryEvent().data, counts: { ...summaryEvent().data.counts, cancelled: 1 } }];
  for (const key of Object.keys(summaryEvent().data.counts)) {
    for (const value of [NaN, Infinity, -1, 0.5, '0', undefined]) {
      summaries.push({ ...summaryEvent().data, counts: { ...summaryEvent().data.counts, [key]: value } });
    }
  }
  for (const data of summaries) {
    const c = await collector();
    c.accept(passEvent());
    c.accept(summaryEvent());
    c.accept({ type: 'test:summary', data });
    assert.equal(c.result(), undefined);
  }
});

test('runtime digest matches an independent fixed-byte vector across creation order and absolute roots', async (t) => {
  const { runtimeDigest } = runtimeApi();
  const root = await evidenceTemp(t);
  const first = join(root, 'first');
  const second = join(root, 'second');
  await digestTree(first);
  await digestTree(second, true);
  assert.equal(await runtimeDigest(first), fixtureDigest);
  assert.equal(await runtimeDigest(second), fixtureDigest);
});

test('runtime digest excludes evidence and non-JS assets but binds paths and bytes in both runtime directories', async (t) => {
  const { runtimeDigest } = runtimeApi();
  const root = await evidenceTemp(t);
  await digestTree(root);
  await writeFile(join(root, 'aws', 'test-evidence.json'), '{"runtimeDigest":"fake"}');
  await writeFile(join(root, 'shared', 'notes.txt'), 'changed ignored asset');
  await writeFile(join(root, 'sibling.js'), 'changed ignored sibling');
  assert.equal(await runtimeDigest(root), fixtureDigest);
  for (const [path, bytes] of digestFiles) {
    await writeFile(join(root, path), 'changed bytes');
    assert.notEqual(await runtimeDigest(root), fixtureDigest, path);
    await writeFile(join(root, path), bytes);
  }
  await rename(join(root, 'aws', 'z.js'), join(root, 'aws', 'renamed.js'));
  assert.notEqual(await runtimeDigest(root), fixtureDigest);
});

test('runtime digest requires both real directories but permits an empty JavaScript inventory', async (t) => {
  const { runtimeDigest } = runtimeApi();
  const root = await evidenceTemp(t);
  await assert.rejects(() => runtimeDigest(root));
  await mkdir(join(root, 'aws'));
  await assert.rejects(() => runtimeDigest(root));
  await writeFile(join(root, 'shared'), 'not a directory');
  await assert.rejects(() => runtimeDigest(root));
  await rm(join(root, 'shared'));
  await mkdir(join(root, 'shared'));
  assert.equal(await runtimeDigest(root), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

for (const location of ['runtime root', 'aws root', 'shared root', 'nested directory', 'JavaScript file', 'ignored non-JS file', 'dangling file']) {
  test(`runtime digest refuses a linked ${location}`, async (t) => {
    const { runtimeDigest } = runtimeApi();
    const root = await evidenceTemp(t);
    const runtime = join(root, 'runtime');
    await digestTree(runtime);
    let target = join(root, 'outside');
    let path = join(runtime, 'aws', 'linked');
    let type = process.platform === 'win32' ? 'junction' : 'dir';
    let input = runtime;
    if (location === 'runtime root') { target = runtime; path = join(root, 'alias'); input = path; }
    else if (location === 'aws root' || location === 'shared root') {
      path = join(runtime, location.startsWith('aws') ? 'aws' : 'shared');
      await rename(path, target);
    } else if (location === 'nested directory') await mkdir(target);
    else {
      type = 'file';
      path = join(runtime, 'aws', location === 'JavaScript file' ? 'alias.js' : 'alias.txt');
      if (location !== 'dangling file') await writeFile(target, 'outside bytes');
    }
    try { await symlink(target, path, type); }
    catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
      t.skip(`link creation unavailable: ${error.code}`);
      return;
    }
    await assert.rejects(() => runtimeDigest(input));
  });
}

test('runtime digest rejects a non-file socket entry even with a non-JS suffix', async (t) => {
  const { runtimeDigest } = runtimeApi();
  if (process.platform === 'win32') { t.skip('Unix filesystem sockets are not available on Windows'); return; }
  const root = await evidenceTemp(t);
  await digestTree(root);
  const server = createServer();
  t.after(() => deadline(new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())), 1000, 'digest socket cleanup'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(join(root, 'aws', 'non-file.sock'), resolve); });
  await assert.rejects(() => runtimeDigest(root));
});

test('parseEvidence accepts valid cases empty inventories all known kinds and well-formed unmodeled operations', () => {
  const { parseEvidence } = runtimeApi();
  assert.deepEqual(parseEvidence(artifact(), fixtureDigest), [expectedPass]);
  assert.deepEqual(parseEvidence({ ...artifact(), cases: [] }, fixtureDigest), []);
  const cases = ['unit', 'protocol', 'lifecycle', 'workflow', 'differential'].map((kind) => ({
    id: `original-opaque-${kind}-case`, operations: ['future.NewOperation'], kind,
  }));
  const result = parseEvidence({ ...artifact(), cases }, fixtureDigest);
  assert.ok(Array.isArray(result));
  assert.deepEqual([...result].sort((a, b) => a.id.localeCompare(b.id)), [...cases].sort((a, b) => a.id.localeCompare(b.id)));
});

test('parseEvidence rejects malformed stale unknown-field and partially valid artifacts without partial credit', () => {
  const { parseEvidence } = runtimeApi();
  const bad = [undefined, null, false, [], {}, { ...artifact(), formatVersion: 2 }, { ...artifact(), formatVersion: '1' },
    { ...artifact(), runtimeDigest: 'f'.repeat(64) }, { ...artifact(), runtimeDigest: fixtureDigest.toUpperCase() },
    { ...artifact(), runtimeDigest: 'g'.repeat(64) }, { ...artifact(), runtimeDigest: '0'.repeat(63) },
    { ...artifact(), extra: true }, { ...artifact(), cases: null }, { ...artifact(), cases: {} },
    { ...artifact(), cases: [copy(expectedPass), copy(expectedPass)] }];
  for (const value of bad) assert.equal(parseEvidence(value, fixtureDigest), undefined);
  for (const item of [null, [], {}, { ...expectedPass, id: '' }, { ...expectedPass, id: 5 },
    { ...expectedPass, kind: 'verified' }, { ...expectedPass, operations: [] }, { ...expectedPass, operations: 'sqs.SendMessage' },
    { ...expectedPass, extra: true }, { ...expectedPass, operations: ['sqs.SendMessage', 'sqs.SendMessage'] }]) {
    assert.equal(parseEvidence({ ...artifact(), cases: [{ ...expectedPass, id: 'separate-valid-case' }, item] }, fixtureDigest), undefined);
  }
  for (const operation of ['sqs', '.SendMessage', 'sqs.', 'sqs.SendMessage.extra', 'sqs.Send Message', 42, null]) {
    assert.equal(parseEvidence({ ...artifact(), cases: [{ ...expectedPass, operations: [operation] }] }, fixtureDigest), undefined);
  }
  assert.equal(parseEvidence(artifact(), fixtureDigest.toUpperCase()), undefined);
  assert.equal(parseEvidence({ ...artifact(), runtimeDigest: 'bad' }, 'bad'), undefined);
});
