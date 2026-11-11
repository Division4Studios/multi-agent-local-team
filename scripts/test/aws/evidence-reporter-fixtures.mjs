import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { URL } from 'node:url';
import { digestTree, expectedPass, expectedSecondPass, fixtureDigest } from './evidence-fixtures.mjs';
import { deadline } from './http-helpers.mjs';

export const previousReceipt = `${JSON.stringify({ formatVersion: 1, runtimeDigest: fixtureDigest, cases: [
  { id: 'original prior-run receipt', operations: ['sqs.CreateQueue'], kind: 'unit' },
] })}\n`;

export async function reporterTree(t, execution) {
  t.after(() => execution?.stop());
  const base = process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  const owned = await mkdtemp(join(base, 'malt-evidence-reporter-'));
  let cleaning;
  const cleanup = () => cleaning ??= (async () => {
    await execution?.stop(); // Never remove a workspace until its process has exited.
    await rm(owned, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  })();
  t.after(cleanup);
  const runtimeRoot = join(owned, 'runtime');
  await digestTree(runtimeRoot);
  const destination = join(runtimeRoot, 'aws', 'test-evidence.json');
  await writeFile(destination, previousReceipt);
  // A failure must clean up only its own files, not every file with a .tmp suffix.
  await writeFile(join(runtimeRoot, 'aws', 'unrelated.keep.tmp'), 'retain these unrelated bytes');
  await mkdir(join(runtimeRoot, 'aws', 'retained-directory'));
  return { owned, runtimeRoot, destination, cleanup };
}

export class ReporterHarnessError extends Error {
  constructor(message, code = 'REPORTER_HARNESS_FAILURE') {
    super(message);
    this.name = 'ReporterHarnessError';
    this.code = code;
  }
}

const errorRecord = (error) => ({ name: error?.name ?? 'Error', message: error?.message ?? String(error),
  stack: error?.stack, code: error?.code });
const fromError = (record) => Object.assign(new Error(record.message), record);

export async function reporter({ mode = 'reporter', milliseconds = 4000 } = {}) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(new URL('./evidence-reporter-child.mjs', import.meta.url), [mode], {
    env, execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const ready = Promise.withResolvers();
  const exited = Promise.withResolvers();
  const started = Promise.withResolvers();
  let response;
  let iterator;
  let stopping;
  let ended = false;
  let diagnostics = '';
  const fail = (error) => { ready.reject(error); response?.reject(error); };
  child.stderr.on('data', (bytes) => { diagnostics = `${diagnostics}${bytes}`.slice(-4000); });
  child.once('error', (error) => fail(new ReporterHarnessError(`reporter process error: ${error.message}`)));
  child.once('exit', (code, signal) => {
    ended = true;
    exited.resolve();
    fail(new ReporterHarnessError(`reporter process exited ${signal ?? code}: ${diagnostics}`));
  });
  const stop = () => stopping ??= (async () => {
    if (ended) return;
    child.kill('SIGKILL');
    try { await deadline(exited.promise, 2000, 'reporter process termination'); }
    catch (error) { throw new ReporterHarnessError(error.message, 'REPORTER_HARNESS_TERMINATION'); }
  })();
  const guard = async (promise, allowance, label) => {
    let timer;
    try {
      return await Promise.race([promise, new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new ReporterHarnessError(`${label} exceeded ${allowance}ms`, 'REPORTER_HARNESS_TIMEOUT')), allowance);
      })]);
    } catch (error) {
      await stop();
      throw error;
    } finally { clearTimeout(timer); }
  };
  const send = (message) => {
    if (stopping || ended) return;
    child.send(message, (error) => { if (error && !stopping) fail(new ReporterHarnessError(`reporter IPC: ${error.message}`)); });
  };
  const next = async (id) => {
    let result;
    try { result = await iterator.next(); }
    catch (error) { send({ type: 'event', id, error: errorRecord(error) }); return; }
    send({ type: 'event', id, result });
  };
  child.on('message', (message) => {
    if (message.type === 'ready') ready.resolve();
    else if (message.type === 'load-error') ready.reject(fromError(message.error));
    else if (message.type === 'started') started.resolve();
    else if (message.type === 'result') response.resolve(message);
    else if (message.type === 'next') next(message.id).catch((error) => fail(new ReporterHarnessError(error.message)));
  });
  await guard(ready.promise, 4000, 'reporter process startup');
  const write = async (events, runtimeRoot) => {
    if (response) throw new ReporterHarnessError('reporter process is single-use');
    response = Promise.withResolvers();
    iterator = events[Symbol.asyncIterator]();
    send({ type: 'run', runtimeRoot });
    const result = await guard(response.promise, milliseconds, 'writeTestEvidence');
    await stop(); // Also terminate background work after an ordinary API outcome.
    if (result.status === 'rejected') throw fromError(result.error);
    return result.value;
  };
  return Object.assign(write, { stop, guard, started: started.promise, exited: () => ended });
}

export function rejectsReporter(action) {
  return assert.rejects(action, (error) => {
    if (error instanceof ReporterHarnessError) throw error;
    return true;
  });
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

// Only API outcomes are normalized. Harness failures propagate as failures;
// a timeout cannot masquerade as an expected reporter rejection.
export function observe(promise) {
  let settled = false;
  const outcome = promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => {
      if (reason instanceof ReporterHarnessError) throw reason;
      return { status: 'rejected', reason };
    },
  ).then((result) => { settled = true; return result; });
  return { outcome, settled: () => settled };
}

export async function beforeEof(writeTestEvidence, fixture, events, inspect = async () => {}, finish) {
  const original = await footprint(fixture);
  const held = holdAtEnd(events, () => absent(fixture.destination), finish);
  const operation = observe(writeTestEvidence(held.events, fixture.runtimeRoot));
  try {
    await writeTestEvidence.guard(Promise.race([
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
    await writeTestEvidence.guard(operation.outcome, 4000, 'reporter must settle after EOF is released');
  }
  return operation.outcome;
}
