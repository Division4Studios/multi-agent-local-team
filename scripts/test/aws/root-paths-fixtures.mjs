import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { digestTree, fixtureDigest } from './evidence-fixtures.mjs';

const require = createRequire(import.meta.url);
export const previousReceipt = `\r\n${JSON.stringify({ cases: [], runtimeDigest: fixtureDigest, formatVersion: 1 })}\r\n`;
const stateBytes = '{ "formatVersion": 1, "documents": [] }\n';
const errorRecord = (error) => ({ name: error.name, message: error.message, code: error.code, stack: error.stack });

export class RootHarnessError extends Error {}

function bounded(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new RootHarnessError(`${label} exceeded ${milliseconds}ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function requireNaturalExit(exit, closeError) {
  if (exit.code !== 0 || closeError) throw new RootHarnessError(`root-path cleanup failed: ${closeError?.message ?? exit.signal ?? exit.code}`);
}

export async function treeBytes(root, prefix = '') {
  const result = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) result.push([relative, 'link', await readlink(path)]);
    else if (entry.isDirectory()) result.push([relative, 'directory'], ...await treeBytes(path, relative));
    else if (entry.isFile()) result.push([relative, 'file', await readFile(path)]);
    else result.push([relative, 'nonregular']);
  }
  return result;
}

function entryDifference(path, actual, expected) {
  if (!actual) return `${path}: removed ${expected[0]}`;
  if (!expected) return `${path}: added ${actual[0]}`;
  if (actual[0] !== expected[0]) return `${path}: type changed from ${expected[0]} to ${actual[0]}`;
  if (actual[0] === 'file' && !actual[1].equals(expected[1])) return `${path}: bytes changed (${expected[1].length} -> ${actual[1].length})`;
  if (actual[0] === 'link' && actual[1] !== expected[1]) return `${path}: link target changed`;
  return undefined;
}

export function assertTree(actual, expected, label = 'tree names, types and exact bytes must match') {
  const observed = new Map(actual.map(([path, ...entry]) => [path, entry]));
  const original = new Map(expected.map(([path, ...entry]) => [path, entry]));
  const paths = new Set([...observed.keys(), ...original.keys()]);
  const differences = [...paths].map((path) => entryDifference(path, observed.get(path), original.get(path))).filter(Boolean);
  assert.deepEqual(differences, [], label);
}

export async function rootFixture(t, mode, linked = false) {
  const base = process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  const owned = await mkdtemp(join(base, 'malt-root-paths-'));
  const children = [];
  t.after(async () => {
    const errors = [];
    for (const child of children) {
      try { await child.close(); } catch (error) { errors.push(error); }
    }
    if (children.every((child) => child.exited())) await rm(owned, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    if (errors.length) throw new AggregateError(errors, 'root-path fixture cleanup failed');
  });
  const target = join(owned, 'target');
  await mkdir(join(target, 'retained'), { recursive: true });
  await writeFile(join(target, 'retained', 'sentinel'), 'target sentinel bytes\n');
  await writeFile(join(owned, 'unrelated.keep.tmp'), 'unrelated sibling bytes\n');
  if (mode === 'state') await writeFile(join(target, 'state.json'), stateBytes);
  else {
    await digestTree(target);
    await writeFile(join(target, 'aws', 'test-evidence.json'), previousReceipt);
  }
  const eventFile = join(owned, 'ordinary-events.mjs');
  await writeFile(eventFile, "import { test } from 'node:test';\ntest('ordinary root-path producer control', () => {});\n");
  const link = join(owned, 'linked-root');
  if (linked) {
    try { await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
      t.skip(`Windows directory junction unavailable: ${error.code}`);
      return undefined;
    }
    assert.ok((await lstat(link)).isSymbolicLink(), 'fixture must contain an actual directory link');
  }
  return { owned, target, link, eventFile, children };
}

export async function rootProbe(fixture, mode, root) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(new URL('./root-paths-fixtures.mjs', import.meta.url), ['--worker', mode, root, fixture.eventFile], {
    env, execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const response = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let outcome;
  let ended = false;
  let closing;
  let closeError;
  let diagnostics = '';
  child.stderr.on('data', (bytes) => { diagnostics = `${diagnostics}${bytes}`.slice(-4000); });
  child.once('error', (error) => response.reject(new RootHarnessError(error.message)));
  child.once('close', (code, signal) => {
    ended = true;
    finished.resolve({ code, signal });
    response.reject(new RootHarnessError(`root-path child closed ${signal ?? code}: ${diagnostics}`));
  });
  child.on('message', (message) => {
    if (message.type === 'outcome') response.resolve(message);
    else if (message.type === 'harness-error') response.reject(new RootHarnessError(message.error.message));
    else if (message.type === 'close-error') closeError = message.error;
  });
  const force = async () => {
    if (ended) return;
    child.kill('SIGKILL');
    await bounded(finished.promise, 2000, 'root-path forced child termination');
  };
  const close = () => closing ??= (async () => {
    if (!ended && mode === 'state' && outcome?.status === 'fulfilled' && child.connected) child.send({ type: 'close' });
    let exit;
    try { exit = await bounded(finished.promise, 2000, 'root-path natural child exit'); }
    catch (error) { await force(); throw error; }
    requireNaturalExit(exit, closeError);
  })();
  const handle = { close, exited: () => ended, pid: child.pid };
  fixture.children.push(handle);
  try {
    outcome = await bounded(response.promise, 5000, `public ${mode} outcome`);
    if (mode !== 'state' || outcome.status !== 'fulfilled') await close();
    return { ...handle, ...outcome };
  } catch (error) { await force(); throw error; }
}

export async function observeRoot(fixture, mode, spelling) {
  const execution = await rootProbe(fixture, mode, spelling);
  let during;
  let cleanupError;
  try { during = await treeBytes(fixture.owned); }
  finally {
    try { await execution.close(); } catch (error) { cleanupError = error; }
  }
  return { execution, during, after: await treeBytes(fixture.owned), cleanupError };
}

// Run every oracle even when startup incorrectly succeeds or preservation fails.
export function assertAll(assertions) {
  const failures = [];
  for (const assertion of assertions) {
    try { assertion(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, failures.map((error) => error.message).join('\n'));
}

async function ordinaryEvents(path) {
  const events = [];
  for await (const event of run({ files: [path], isolation: 'process', timeout: 2000, execArgv: [] })) events.push(event);
  const summary = events.filter(({ type, data }) => type === 'test:summary' && data.file === undefined);
  assert.equal(summary.length, 1, 'ordinary event producer must reach its real cumulative summary');
  assert.equal(summary[0].data.success, true);
  assert.equal(summary[0].data.counts.passed, 1);
  assert.ok(events.every(({ data }) => !data.name?.startsWith('aws[')), 'root controls must not claim operation evidence');
  return events;
}

async function actionFor(mode, root, eventFile, state) {
  if (mode === 'state') {
    const { startAwsServer } = require('../../../out/aws/server.js');
    assert.equal(typeof startAwsServer, 'function');
    return async () => {
      state.running = await startAwsServer({ host: '127.0.0.1', port: 0, adminPort: 0,
        adminToken: 'original-root-path-control-token-0123456789', stateDirectory: root });
      return { gatewayUrl: state.running.gatewayUrl, adminUrl: state.running.adminUrl };
    };
  }
  if (mode === 'digest') {
    const { runtimeDigest } = require('../../../out/aws/coverage/evidence.js');
    assert.equal(typeof runtimeDigest, 'function');
    return () => runtimeDigest(root);
  }
  assert.equal(mode, 'reporter');
  const { writeTestEvidence } = await import('../../aws-evidence-reporter.mts');
  assert.equal(typeof writeTestEvidence, 'function');
  const events = await ordinaryEvents(eventFile);
  state.metrics = { produced: events.length, started: 0, consumed: 0, ended: 0 };
  async function* recorded() {
    state.metrics.started++;
    for (const event of events) { state.metrics.consumed++; yield event; }
    state.metrics.ended++;
  }
  return () => writeTestEvidence(recorded(), root);
}

const send = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));

async function worker() {
  const state = {};
  const action = await actionFor(process.argv[3], process.argv[4], process.argv[5], state);
  process.on('message', (message) => {
    if (message.type !== 'close') return;
    const close = async () => {
      try { await state.running?.close(); }
      catch (error) { await send({ type: 'close-error', error: errorRecord(error) }); }
      process.disconnect();
    };
    close().catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
  });
  let outcome;
  try { outcome = { status: 'fulfilled', value: await action() }; }
  catch (error) { outcome = { status: 'rejected', error: errorRecord(error) }; }
  await send({ type: 'outcome', ...outcome, metrics: state.metrics });
  if (!state.running) process.disconnect();
}

if (process.argv[2] === '--worker') {
  worker().catch(async (error) => {
    await send({ type: 'harness-error', error: errorRecord(error) });
    if (process.connected) process.disconnect();
  });
}
