import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { digestTree, evidenceTemp, expectedPass, expectedSecondPass, fixtureDigest } from './evidence-fixtures.mjs';
import { deadline } from './http-helpers.mjs';

export const previousReceipt = `${JSON.stringify({ formatVersion: 1, runtimeDigest: fixtureDigest, cases: [
  { id: 'original prior-run receipt', operations: ['sqs.CreateQueue'], kind: 'unit' },
] })}\n`;

export async function reporterTree(t) {
  const owned = await evidenceTemp(t);
  const runtimeRoot = join(owned, 'runtime');
  await digestTree(runtimeRoot);
  const destination = join(runtimeRoot, 'aws', 'test-evidence.json');
  await writeFile(destination, previousReceipt);
  // A failure must clean up only its own files, not every file with a .tmp suffix.
  await writeFile(join(runtimeRoot, 'aws', 'unrelated.keep.tmp'), 'retain these unrelated bytes');
  await mkdir(join(runtimeRoot, 'aws', 'retained-directory'));
  return { owned, runtimeRoot, destination };
}

export async function absent(path) {
  await assert.rejects(() => lstat(path), { code: 'ENOENT' });
}

async function inventory(root, prefix = '') {
  const entries = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) entries.push([relative, 'link', await readlink(path)]);
    else if (entry.isDirectory()) {
      entries.push([relative, 'directory']);
      entries.push(...await inventory(path, relative));
    } else if (entry.isFile()) entries.push([relative, 'file', await readFile(path)]);
    else entries.push([relative, 'nonregular']);
  }
  return entries;
}

// Compare names, types and bytes throughout the owned tree, including siblings
// outside runtime/. Ignore only the public receipt entry, never unknown temp names.
// Links are recorded without following them. This is not a second digest oracle.
export async function footprint(fixture) {
  return new Map((await inventory(fixture.owned))
    .filter(([path]) => path !== 'runtime/aws/test-evidence.json')
    .map(([path, ...details]) => [path, details]));
}

const outsideAws = (entries) => new Map([...entries].filter(([path]) => path !== 'runtime/aws' && !path.startsWith('runtime/aws/')));

export async function publishedReceipt(fixture) {
  assert.ok((await lstat(fixture.destination)).isFile(), 'receipt must be a regular file');
  assert.deepEqual(JSON.parse(await readFile(fixture.destination, 'utf8')), {
    formatVersion: 1, runtimeDigest: fixtureDigest, cases: [expectedPass, expectedSecondPass],
  });
}

export async function* eventStream(events, start = async () => {}, finish = async () => {}) {
  await start();
  yield* events; // Preserve the original Node envelope objects and their order.
  await finish();
}

export function holdAtEnd(events, start, finish) {
  const arrived = Promise.withResolvers();
  const resume = Promise.withResolvers();
  return {
    arrived: arrived.promise,
    release: () => resume.resolve(),
    events: eventStream(events, start, async () => {
      arrived.resolve();
      await resume.promise;
      await finish?.();
    }),
  };
}

// Both outcomes are handled immediately. Test deadlines remain outside this
// observation, so a timeout cannot masquerade as an expected API rejection.
export function observe(promise) {
  let settled = false;
  const outcome = promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  ).then((result) => { settled = true; return result; });
  return { outcome, settled: () => settled };
}

export async function beforeEof(writeTestEvidence, fixture, events, inspect = async () => {}, finish) {
  const original = await footprint(fixture);
  const held = holdAtEnd(events, () => absent(fixture.destination), finish);
  const operation = observe(writeTestEvidence(held.events, fixture.runtimeRoot));
  try {
    await deadline(Promise.race([
      held.arrived,
      operation.outcome.then(() => assert.fail('reporter settled before requesting stream EOF')),
    ]), 4000, 'reporter must consume events through the EOF barrier');
    await absent(fixture.destination);
    await sleep(75); // Keep EOF withheld while filesystem work could otherwise publish.
    assert.equal(operation.settled(), false, 'reporter returned while EOF was withheld');
    await absent(fixture.destination);
    assert.deepEqual(outsideAws(await footprint(fixture)), outsideAws(original), 'publication work must remain under aws/');
    await inspect();
  } finally {
    held.release();
    await deadline(operation.outcome, 4000, 'reporter must settle after EOF is released');
  }
  return operation.outcome;
}
