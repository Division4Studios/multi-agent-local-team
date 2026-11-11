import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { link, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { originalEvents } from './evidence-fixtures.mjs';
import { absent, beforeEof, eventStream, footprint, holdAtEnd, observe, previousReceipt,
  publishedReceipt, rejectsReporter, reporter, ReporterHarnessError, reporterTree } from './evidence-reporter-fixtures.mjs';
import { deadline } from './http-helpers.mjs';

const cumulative = ({ type, data }) => type === 'test:summary' && data.file === undefined;

test('reporter fixture preserves genuine Node events while withholding EOF until explicit release', { timeout: 10000 }, async (t) => {
  const events = await originalEvents(t);
  assert.equal(events.filter(cumulative).length, 1);
  assert.equal(events.find(cumulative).data.success, true);
  const held = holdAtEnd(events);
  const received = [];
  const consumer = observe((async () => { for await (const event of held.events) received.push(event); })());
  try {
    await deadline(held.arrived, 2000, 'fixture must reach its EOF barrier');
    assert.equal(consumer.settled(), false);
    assert.equal(received.length, events.length);
    for (const [index, event] of events.entries()) assert.equal(received[index], event);
  } finally {
    held.release();
    assert.deepEqual(await deadline(consumer.outcome, 2000, 'fixture EOF release'), { status: 'fulfilled', value: undefined });
  }
});

test('reporter fixture footprint detects publication debris inside and outside aws without discarding unrelated files', async (t) => {
  const f = await reporterTree(t);
  const original = await footprint(f);
  for (const path of [join(f.runtimeRoot, 'aws', 'unexpected.tmp'), join(f.owned, 'unexpected.tmp')]) {
    await writeFile(path, 'deliberate leftover');
    assert.notDeepEqual(await footprint(f), original);
    await rm(path);
    assert.deepEqual(await footprint(f), original);
  }
  assert.equal(await readFile(f.destination, 'utf8'), previousReceipt);
});

test('reporter harness preserves genuine envelopes EOF gating and first-consumption mutation before the first yield', { timeout: 12000 }, async (t) => {
  const consume = await reporter({ mode: 'consume-control' });
  const f = await reporterTree(t, consume);
  const events = await originalEvents(t);
  let started = 0;
  const held = holdAtEnd(events, async () => {
    started += 1;
    await writeFile(join(f.runtimeRoot, 'aws', 'z.js'), 'exports.z = 3;\n');
  });
  const operation = observe(consume(held.events, f.runtimeRoot));
  try {
    await consume.guard(Promise.race([
      held.arrived,
      operation.outcome.then(() => assert.fail('consumer completed before EOF release')),
    ]), 2000, 'consumer must reach the producer EOF gate');
    assert.equal(operation.settled(), false);
  } finally {
    held.release();
    await consume.guard(operation.outcome, 4000, 'consumer must settle after EOF release');
  }
  const { status, value: result } = await operation.outcome;
  assert.equal(status, 'fulfilled');
  assert.equal(started, 1);
  assert.equal(result.before, 'exports.z = 2;\n');
  assert.equal(result.first, 'exports.z = 3;\n');
  assert.deepEqual(result.events, events);
  assert.equal(consume.exited(), true);
  assert.equal(await readFile(f.destination, 'utf8'), previousReceipt, 'harness consumer never publishes evidence');
});

test('reporter harness forwards an original producer error separately from execution failures', { timeout: 10000 }, async (t) => {
  const consume = await reporter({ mode: 'consume-control' });
  const f = await reporterTree(t, consume);
  const stream = eventStream([], async () => {
    throw Object.assign(new Error('original producer failure'), { code: 'ORIGINAL_PRODUCER_FAILURE' });
  });
  await assert.rejects(() => consume(stream, f.runtimeRoot), { message: 'original producer failure', code: 'ORIGINAL_PRODUCER_FAILURE' });
  assert.equal(consume.exited(), true);
});

test('reporter harness timeout terminates a stalled writer and awaits exit before workspace cleanup', { timeout: 10000 }, async (t) => {
  const stalled = await reporter({ mode: 'stall-control', milliseconds: 500 });
  const f = await reporterTree(t, stalled);
  // The expected-API-rejection helper must itself reject a harness timeout.
  const outcome = rejectsReporter(() => stalled(eventStream([]), f.runtimeRoot))
    .then(() => ({ accepted: true }), (error) => ({ error }));
  await stalled.guard(stalled.started, 1000, 'stalled writer must start');
  assert.equal(stalled.exited(), false);
  const marker = join(f.runtimeRoot, 'aws', 'harness-active');
  assert.ok((await readFile(marker)).length > 0);
  const { error } = await outcome;
  assert.ok(error instanceof ReporterHarnessError);
  assert.equal(error.code, 'REPORTER_HARNESS_TIMEOUT');
  assert.equal(stalled.exited(), true, 'timeout must not settle before termination is observed');
  const stoppedBytes = await readFile(marker);
  await sleep(75);
  assert.deepEqual(await readFile(marker), stoppedBytes, 'writer is stopped before cleanup starts');
  await f.cleanup();
  await absent(f.owned);
});

test('reporter invalidates the old receipt before consuming events and publishes exact genuine cases only after EOF', { timeout: 15000 }, async (t) => {
  const write = await reporter();
  const f = await reporterTree(t, write);
  const original = await footprint(f);
  const result = await beforeEof(write, f, await originalEvents(t));
  assert.deepEqual(result, { status: 'fulfilled', value: true });
  await publishedReceipt(f);
  assert.deepEqual(await footprint(f), original);
});

for (const kind of ['failed', 'incomplete', 'empty']) {
  test(`reporter ${kind} stream returns false and invalidates prior successful evidence without leftover files`, { timeout: 12000 }, async (t) => {
    const write = await reporter();
    const f = await reporterTree(t, write);
    const original = await footprint(f);
    const genuine = kind === 'empty' ? [] : await originalEvents(t, kind === 'failed');
    if (kind === 'failed') assert.equal(genuine.find(cumulative).data.success, false);
    if (kind === 'incomplete') {
      assert.ok(genuine.some(cumulative));
      assert.ok(genuine.some(({ type, data }) => type === 'test:summary' && data.file !== undefined));
    }
    const events = kind === 'incomplete' ? genuine.filter((event) => !cumulative(event)) : genuine;
    const value = await write(eventStream(events, () => absent(f.destination)), f.runtimeRoot);
    assert.equal(value, false);
    await absent(f.destination);
    assert.deepEqual(await footprint(f), original);
  });
}

test('reporter invalidates old evidence even when the stream throws before yielding its first event', { timeout: 12000 }, async (t) => {
  const write = await reporter();
  const f = await reporterTree(t, write);
  const original = await footprint(f);
  let artifactAtStart;
  let threw = false;
  const stream = eventStream([], async () => {
    artifactAtStart = await lstat(f.destination).then(() => true, (error) => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    });
    threw = true;
    throw new Error('original stream failure before any envelope');
  });
  await rejectsReporter(() => write(stream, f.runtimeRoot));
  assert.equal(threw, true);
  assert.equal(artifactAtStart, false);
  await absent(f.destination);
  assert.deepEqual(await footprint(f), original);
});

test('reporter rejects a stream that throws after a genuine success summary without publishing a receipt', { timeout: 15000 }, async (t) => {
  const write = await reporter();
  const f = await reporterTree(t, write);
  const original = await footprint(f);
  let threw = false;
  const result = await beforeEof(write, f, await originalEvents(t), undefined, async () => {
    threw = true;
    throw new Error('original failure instead of normal EOF');
  });
  assert.equal(threw, true);
  assert.equal(result.status, 'rejected');
  await absent(f.destination);
  assert.deepEqual(await footprint(f), original);
});

test('reporter consumes a late genuine failure after success and a repeated success summary cannot restore credit', { timeout: 15000 }, async (t) => {
  const write = await reporter();
  const f = await reporterTree(t, write);
  const original = await footprint(f);
  const success = await originalEvents(t);
  const failed = await originalEvents(t, true);
  const ordinaryFailure = failed.find(({ type, data }) => type === 'test:fail' && data.name === 'ordinary test');
  assert.ok(ordinaryFailure);
  // Adversarial ordering of genuine, unmodified envelopes from the two runs.
  const events = [...success, ordinaryFailure, success.find(cumulative)];
  assert.equal(await write(eventStream(events), f.runtimeRoot), false);
  await absent(f.destination);
  assert.deepEqual(await footprint(f), original);
});

test('reporter refuses credit for a JavaScript mutation in first consumption before the first event is yielded', { timeout: 15000 }, async (t) => {
  const write = await reporter();
  const f = await reporterTree(t, write);
  const expected = await footprint(f);
  expected.set('runtime/aws/z.js', ['file', Buffer.from('exports.z = 3;\n')]);
  let consumed = false;
  const events = eventStream(await originalEvents(t), async () => {
    await absent(f.destination);
    await writeFile(join(f.runtimeRoot, 'aws', 'z.js'), 'exports.z = 3;\n');
    consumed = true;
  });
  const result = await observe(write(events, f.runtimeRoot)).outcome;
  assert.equal(consumed, true, 'mutation must occur on the producer first-consumption path');
  assert.ok(result.status === 'rejected' || result.value === false);
  await absent(f.destination);
  assert.deepEqual(await footprint(f), expected);
});

for (const [label, mutate] of [
  ['aws JavaScript bytes', async (f, expected) => {
    await writeFile(join(f.runtimeRoot, 'aws', 'z.js'), 'exports.z = 3;\n');
    expected.set('runtime/aws/z.js', ['file', Buffer.from('exports.z = 3;\n')]);
  }],
  ['shared JavaScript bytes', async (f, expected) => {
    await writeFile(join(f.runtimeRoot, 'shared', 'base.js'), 'changed shared bytes');
    expected.set('runtime/shared/base.js', ['file', Buffer.from('changed shared bytes')]);
  }],
  ['JavaScript inventory paths', async (f, expected) => {
    await rename(join(f.runtimeRoot, 'aws', 'z.js'), join(f.runtimeRoot, 'aws', 'renamed.js'));
    expected.set('runtime/aws/renamed.js', expected.get('runtime/aws/z.js'));
    expected.delete('runtime/aws/z.js');
  }],
]) {
  test(`reporter refuses credit when ${label} change between the start digest and EOF`, { timeout: 15000 }, async (t) => {
    const write = await reporter();
    const f = await reporterTree(t, write);
    const expected = await footprint(f);
    const result = await beforeEof(write, f, await originalEvents(t), async () => {
      await mutate(f, expected);
    });
    // The contract forbids publication on a mismatch, without separately naming
    // its false-versus-rejection outcome. Filesystem digest errors below must reject.
    assert.ok(result.status === 'rejected' || result.value === false);
    await absent(f.destination);
    assert.deepEqual(await footprint(f), expected);
  });
}

test('reporter permits an ignored non-JavaScript asset to change during the run and keeps the fixed runtime digest', { timeout: 15000 }, async (t) => {
  const write = await reporter();
  const f = await reporterTree(t, write);
  const expected = await footprint(f);
  const result = await beforeEof(write, f, await originalEvents(t), async () => {
    await writeFile(join(f.runtimeRoot, 'shared', 'notes.txt'), 'changed ignored asset');
    expected.set('runtime/shared/notes.txt', ['file', Buffer.from('changed ignored asset')]);
  });
  assert.deepEqual(result, { status: 'fulfilled', value: true });
  await publishedReceipt(f);
  assert.deepEqual(await footprint(f), expected);
});

for (const shape of ['missing shared directory', 'non-directory shared root']) {
  test(`reporter invalidates an ordinary receipt before rejecting a ${shape}`, { timeout: 12000 }, async (t) => {
    const write = await reporter();
    const f = await reporterTree(t, write);
    await rm(join(f.runtimeRoot, 'shared'), { recursive: true });
    if (shape === 'non-directory shared root') await writeFile(join(f.runtimeRoot, 'shared'), 'not a directory');
    const original = await footprint(f);
    let consumed = false;
    const events = eventStream(await originalEvents(t), async () => { consumed = true; });
    await rejectsReporter(() => write(events, f.runtimeRoot));
    assert.equal(consumed, false, 'initial runtime validation precedes event consumption');
    await absent(f.destination);
    assert.deepEqual(await footprint(f), original);
  });
}

test('reporter rejects an end-of-run digest filesystem failure and removes all owned publication files', { timeout: 15000 }, async (t) => {
  const write = await reporter();
  const f = await reporterTree(t, write);
  const expected = await footprint(f);
  for (const path of expected.keys()) if (path === 'runtime/shared' || path.startsWith('runtime/shared/')) expected.delete(path);
  const result = await beforeEof(write, f, await originalEvents(t), async () => {
    await rm(join(f.runtimeRoot, 'shared'), { recursive: true });
  });
  assert.equal(result.status, 'rejected');
  await absent(f.destination);
  assert.deepEqual(await footprint(f), expected);
});

test('reporter rejects a nonregular existing destination without removing its unrelated contents', { timeout: 12000 }, async (t) => {
  const write = await reporter();
  const f = await reporterTree(t, write);
  await rm(f.destination);
  await mkdir(f.destination);
  const marker = join(f.destination, 'owned-by-fixture');
  await writeFile(marker, 'retain directory contents');
  const original = await footprint(f);
  await rejectsReporter(() => write(eventStream([]), f.runtimeRoot));
  assert.ok((await lstat(f.destination)).isDirectory());
  assert.equal(await readFile(marker, 'utf8'), 'retain directory contents');
  assert.deepEqual(await footprint(f), original);
});

for (const kind of ['hardlink', 'symlink', 'dangling symlink']) {
  test(`reporter rejects a ${kind} destination without following it or changing outside bytes`, { timeout: 12000 }, async (t) => {
    const write = await reporter();
    const f = await reporterTree(t, write);
    const outside = join(f.owned, 'outside-evidence.json');
    if (kind !== 'dangling symlink') await writeFile(outside, previousReceipt);
    await rm(f.destination);
    try {
      if (kind === 'hardlink') await link(outside, f.destination);
      else await symlink(outside, f.destination, 'file');
    } catch (error) {
      if (kind === 'hardlink' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
      t.skip(`file symlinks unavailable: ${error.code}; no reporter evidence`);
      return;
    }
    const linked = await lstat(f.destination);
    const original = await footprint(f);
    const events = await originalEvents(t);
    await rejectsReporter(() => write(eventStream(events), f.runtimeRoot));
    if (kind === 'dangling symlink') await absent(outside);
    else assert.equal(await readFile(outside, 'utf8'), previousReceipt);
    const remaining = await lstat(f.destination).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (remaining) {
      assert.equal(remaining.ino, linked.ino, 'rejection must not replace the link with published evidence');
      assert.equal(remaining.isSymbolicLink(), linked.isSymbolicLink());
    }
    assert.deepEqual(await footprint(f), original);
  });
}

test('reporter rejects a linked aws directory before invalidation can change an outside receipt', { timeout: 12000 }, async (t) => {
  const write = await reporter();
  const f = await reporterTree(t, write);
  const outside = join(f.owned, 'outside-aws');
  await rename(join(f.runtimeRoot, 'aws'), outside);
  await symlink(outside, join(f.runtimeRoot, 'aws'), process.platform === 'win32' ? 'junction' : 'dir');
  const original = await footprint(f);
  await rejectsReporter(() => write(eventStream([]), f.runtimeRoot));
  assert.equal(await readFile(join(outside, 'test-evidence.json'), 'utf8'), previousReceipt);
  assert.deepEqual(await footprint(f), original);
});

test('reporter publication failure at EOF cleans owned temporary files and preserves a new destination directory', { timeout: 15000 }, async (t) => {
  const write = await reporter();
  const f = await reporterTree(t, write);
  const marker = join(f.destination, 'owned-by-fixture');
  const expected = await footprint(f);
  expected.set('runtime/aws/test-evidence.json/owned-by-fixture', ['file', Buffer.from('do not delete to force publication')]);
  const result = await beforeEof(write, f, await originalEvents(t), async () => {
    // A nonempty directory is a portable real-filesystem publication obstacle.
    // It contains no JS, so the runtime digest itself remains valid and unchanged.
    await mkdir(f.destination);
    await writeFile(marker, 'do not delete to force publication');
  });
  assert.equal(result.status, 'rejected');
  assert.ok((await lstat(f.destination)).isDirectory());
  assert.equal(await readFile(marker, 'utf8'), 'do not delete to force publication');
  assert.deepEqual(await footprint(f), expected);
});
