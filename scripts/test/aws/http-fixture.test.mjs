import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';
import { URL } from 'node:url';
import { deadline, fixture } from './http-helpers.mjs';

const realFork = childProcess.fork;
const alive = (child) => child.exitCode === null && child.signalCode === null;

async function controlledFixture(t, mode) {
  const children = [];
  const hooks = [];
  const events = [];
  const kills = new Map();
  let refuseKill = mode === 'unsettled';
  let f;
  let cleaning;
  const mocked = t.mock.method(childProcess, 'fork', (module, args, options) => {
    assert.equal(module.href, new URL('./server-child.mjs', import.meta.url).href);
    events.push({ type: 'fork', previousAlive: children.some(alive) });
    const child = realFork(new URL('./http-fixture-child.mjs', import.meta.url), [mode], options);
    children.push(child);
    const send = child.send.bind(child);
    child.send = (message, ...rest) => {
      if (message.command) events.push({ type: 'command', command: message.command });
      return send(message, ...rest);
    };
    const kill = child.kill.bind(child);
    kills.set(child, kill);
    child.kill = (signal) => { events.push({ type: 'kill', signal }); return refuseKill ? false : kill(signal); };
    child.once('exit', (code, signal) => events.push({ type: 'exit', code, signal, rootExists: existsSync(f.root) }));
    // Acknowledge stderr consumption before the synthetic child rejects startup.
    child.stderr.once('data', () => child.send({ control: 'diagnostic-read' }));
    return child;
  });
  syncBuiltinESMExports();
  const cleanup = () => cleaning ??= (async () => { for (const hook of hooks) await hook(); })();
  t.after(async () => {
    mocked.mock.restore();
    syncBuiltinESMExports();
    try { if (!cleaning) await cleanup(); }
    finally {
      for (const child of children.filter(alive)) {
        const exited = once(child, 'exit');
        kills.get(child)('SIGKILL');
        await deadline(exited, 2000, 'ownership control emergency termination');
      }
      if (f) await rm(f.root, { recursive: true, force: true });
    }
  });
  f = await fixture({ after: (hook) => hooks.push(hook) });
  return { ...f, cleanup, children, events, allowKill: () => { refuseKill = false; } };
}

async function originalRejection(action) {
  await assert.rejects(action, (error) => {
    assert.equal(error.name, 'OwnedStartupError');
    assert.equal(error.code, 'OWNED_START_REJECTION');
    assert.equal(error.message, 'original startup rejection\nowned startup diagnostic\n');
    assert.equal(error.stack, 'original owned startup stack');
    return true;
  });
}

test('HTTP fixture rejected starts exit naturally before the next start and retain the original error', { timeout: 12000 }, async (t) => {
  const f = await controlledFixture(t, 'clean');
  for (let index = 0; index < 2; index += 1) {
    await originalRejection(() => f.start());
    assert.equal(f.children[index].exitCode, 0, 'rejection must await natural exit');
    assert.equal(f.children[index].signalCode, null);
  }
  assert.ok(f.events.filter(({ type }) => type === 'fork').every(({ previousAlive }) => !previousAlive));
  assert.equal(f.events.some(({ type }) => type === 'kill'), false);
  assert.ok(f.events.filter(({ type }) => type === 'exit').every(({ rootExists }) => rootExists));
  assert.deepEqual(f.events.filter(({ type }) => type === 'command').map(({ command }) => command), ['start', 'start']);
  await f.cleanup();
  await assert.rejects(() => stat(f.root), { code: 'ENOENT' });
});

test('HTTP fixture leaked rejected-start handle fails final cleanup despite expected rejection and exits before removal', { timeout: 12000 }, async (t) => {
  const f = await controlledFixture(t, 'leak');
  await originalRejection(() => f.start());
  assert.equal(alive(f.children[0]), false, 'forced termination must be awaited before rejection returns');
  assert.deepEqual(f.events.filter(({ type }) => type === 'kill').map(({ signal }) => signal), ['SIGKILL']);
  assert.ok(f.events.find(({ type }) => type === 'exit').rootExists, 'workspace must still exist at process exit');
  assert.match(await readFile(join(f.root, 'leaked-handle.log'), 'utf8'), /tick/u);
  assert.deepEqual(f.events.filter(({ type }) => type === 'command').map(({ command }) => command), ['start']);
  await assert.rejects(f.cleanup, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, 'AWS test cleanup failed');
    assert.equal(error.errors.length, 1);
    assert.match(error.errors[0].message, /rejected AWS process must quiesce exceeded 2000ms/u);
    return true;
  });
  await assert.rejects(() => stat(f.root), { code: 'ENOENT' });
});

test('HTTP fixture abnormal rejected-start exit remains a distinct cleanup failure without replacing startup error', { timeout: 12000 }, async (t) => {
  const f = await controlledFixture(t, 'abnormal');
  await originalRejection(() => f.start());
  assert.equal(f.children[0].exitCode, 23);
  assert.equal(f.events.some(({ type }) => type === 'kill'), false);
  assert.deepEqual(f.events.filter(({ type }) => type === 'command').map(({ command }) => command), ['start']);
  await assert.rejects(f.cleanup, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    assert.equal(error.errors[0].code, 'ERR_ASSERTION');
    assert.equal(error.errors[0].actual, 23);
    assert.equal(error.errors[0].expected, 0);
    return true;
  });
  await assert.rejects(() => stat(f.root), { code: 'ENOENT' });
});

test('HTTP fixture unconfirmed forced termination fails cleanup and retains owned files until the child exits', { timeout: 15000 }, async (t) => {
  const f = await controlledFixture(t, 'unsettled');
  await originalRejection(() => f.start());
  assert.equal(alive(f.children[0]), true);
  await assert.rejects(f.cleanup, (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 3);
    assert.match(error.errors[0].message, /rejected AWS process must quiesce exceeded 2000ms/u);
    for (const failure of error.errors.slice(1)) assert.match(failure.message, /isolated AWS process termination exceeded 2000ms/u);
    return true;
  });
  assert.equal(alive(f.children[0]), true);
  assert.ok((await stat(f.root)).isDirectory(), 'unsettled child must retain its owned workspace');
  assert.deepEqual(f.events.filter(({ type }) => type === 'command').map(({ command }) => command), ['start']);
  assert.equal(f.events.filter(({ type }) => type === 'kill').length, 2, 'both failing termination attempts remain bounded');
  f.allowKill();
  const exited = once(f.children[0], 'exit');
  f.children[0].kill('SIGKILL');
  await deadline(exited, 2000, 'release ownership control child');
  assert.ok(f.events.find(({ type }) => type === 'exit').rootExists);
});
