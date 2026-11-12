import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixtureDigest } from './evidence-fixtures.mjs';
import { assertAll, assertTree, observeRoot, previousReceipt, rootFixture, treeBytes } from './root-paths-fixtures.mjs';

// Raw concatenation is intentional: path.join/resolve would erase the final dot.
const spellings = [['bare', ''], ['trailing slash', '/'], ['final dot', '/.']];
const sentinelEntries = (tree) => tree.filter(([path]) => path === 'unrelated.keep.tmp' || path.startsWith('target/retained'));
const withoutReceipt = (tree) => tree.filter(([path]) => path !== 'target/aws/test-evidence.json');

function stopped(observed) {
  assert.equal(observed.cleanupError, undefined, 'cleanup failure must not masquerade as API rejection');
  assert.equal(observed.execution.exited(), true, 'child must exit before fixture removal');
  assert.throws(() => process.kill(observed.execution.pid, 0), { code: 'ESRCH' });
}

test('root-path preservation oracle detects bytes, extra files, removed entries and type changes', async (t) => {
  const f = await rootFixture(t, 'reporter');
  const before = await treeBytes(f.owned);
  const receipt = join(f.target, 'aws', 'test-evidence.json');
  const changedBytes = await readFile(receipt);
  changedBytes[0] ^= 1; // Same length: an inventory/size-only comparison must fail this control.
  await writeFile(receipt, changedBytes);
  let changed = await treeBytes(f.owned);
  assert.throws(() => assertTree(changed, before), /test-evidence.json: bytes changed/u);
  await writeFile(receipt, previousReceipt);
  const debris = join(f.target, 'unowned.tmp');
  await writeFile(debris, 'unexpected new file');
  changed = await treeBytes(f.owned);
  assert.throws(() => assertTree(changed, before), /unowned.tmp: added file/u);
  await rm(debris);
  const sentinel = join(f.owned, 'unrelated.keep.tmp');
  await rm(sentinel);
  changed = await treeBytes(f.owned);
  assert.throws(() => assertTree(changed, before), /unrelated.keep.tmp: removed file/u);
  await mkdir(sentinel);
  changed = await treeBytes(f.owned);
  assert.throws(() => assertTree(changed, before), /unrelated.keep.tmp: type changed/u);
  await rm(sentinel, { recursive: true });
  await writeFile(sentinel, 'unrelated sibling bytes\n');
  assertTree(await treeBytes(f.owned), before);
});

test('root-path combined oracle reports rejection and preservation failures without short-circuiting', () => {
  let checkedPreservation = false;
  assert.throws(() => assertAll([
    () => assert.equal('fulfilled', 'rejected', 'deliberately defective startup outcome'),
    () => { checkedPreservation = true; assert.deepEqual(['changed'], ['original'], 'deliberately changed target'); },
  ]), (error) => error instanceof AggregateError && error.errors.length === 2);
  assert.equal(checkedPreservation, true);
});

for (const [label, suffix] of spellings) {
  for (const mode of ['state', 'digest', 'reporter']) {
    test(`public ${mode} rejects linked root with ${label} before target mutation${mode === 'reporter' ? ' or event consumption' : ''}`, { timeout: 15000 }, async (t) => {
      const f = await rootFixture(t, mode, true);
      if (!f) return;
      const raw = f.link + suffix;
      assert.equal(raw.slice(f.link.length), suffix, 'raw trigger must survive fixture construction');
      t.diagnostic(`${process.platform} ${process.version}: bare link=true; supplied spelling link=${(await lstat(raw)).isSymbolicLink()}`);
      const before = await treeBytes(f.owned);
      const observed = await observeRoot(f, mode, raw);
      const assertions = [
        () => assert.equal(observed.execution.status, 'rejected', `public ${mode} must reject the linked root`),
        () => assertTree(observed.during, before, 'target and sibling tree/bytes must be unchanged at API settlement'),
        () => assertTree(observed.after, before, 'target and sibling tree/bytes must remain unchanged after cleanup'),
        () => assertTree(sentinelEntries(observed.after), sentinelEntries(before), 'unrelated target and sibling sentinels must survive'),
        () => stopped(observed),
      ];
      if (mode === 'reporter') assertions.push(
        () => assert.equal(observed.execution.metrics.started, 0, 'linked root rejection must precede first event consumption'),
        () => assert.equal(observed.execution.metrics.consumed, 0, 'no producer event may be consumed through the linked root'),
      );
      assertAll(assertions);
    });

    test(`public ${mode} accepts a real root with ${label}`, { timeout: 15000 }, async (t) => {
      const f = await rootFixture(t, mode);
      const before = await treeBytes(f.owned);
      const observed = await observeRoot(f, mode, f.target + suffix);
      assertAll([
        () => assert.equal(observed.execution.status, 'fulfilled', observed.execution.error?.message),
        () => stopped(observed),
        () => assertTree(sentinelEntries(observed.after), sentinelEntries(before)),
      ]);
      if (mode === 'state') {
        assert.match(observed.execution.value.gatewayUrl, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);
        assert.match(observed.execution.value.adminUrl, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);
        assert.ok(!observed.after.some(([path]) => path === 'target/.lock'), 'public close must release its owned lock');
      } else if (mode === 'digest') {
        assert.equal(observed.execution.value, fixtureDigest, 'fixed independent byte-stream digest');
        assertTree(observed.after, before, 'digest is read-only');
      } else {
        assert.equal(observed.execution.value, true);
        assert.ok(observed.execution.metrics.produced > 0);
        assert.equal(observed.execution.metrics.consumed, observed.execution.metrics.produced);
        assert.equal(observed.execution.metrics.ended, 1, 'genuine ordinary events must reach EOF');
        assert.deepEqual(JSON.parse(await readFile(join(f.target, 'aws', 'test-evidence.json'), 'utf8')),
          { formatVersion: 1, runtimeDigest: fixtureDigest, cases: [] });
        assertTree(withoutReceipt(observed.after), withoutReceipt(before), 'publication may change only the owned receipt');
      }
    });
  }
}
