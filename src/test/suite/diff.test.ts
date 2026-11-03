import assert from 'node:assert/strict';
import { hunkId, newFileHunks, parseUnifiedDiff } from '../../diff/unifiedDiff';
import type { TestCase } from './harness';

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@ export const a = 1;',
  ' line one',
  '-old two',
  '+new two',
  '+added three',
  ' line four',
  ' line five',
  '@@ -20,3 +21,2 @@',
  ' context',
  '-removed only',
  ' context after',
  '',
].join('\n');

export const tests: readonly TestCase[] = [
  {
    name: 'parseUnifiedDiff: outlines first to last changed line of each hunk',
    run: (): void => {
      const hunks = parseUnifiedDiff(PATCH);
      assert.deepEqual(
        hunks.map((hunk) => [hunk.startLine, hunk.endLine, hunk.added, hunk.removed]),
        [
          [1, 2, 2, 1],
          [21, 21, 0, 1],
        ],
      );
      const [firstHunk] = hunks;
      if (firstHunk === undefined) {
        assert.fail('expected a hunk');
      }
      assert.ok(firstHunk.header.startsWith('@@ -1,4 +1,5 @@'));
      assert.ok(firstHunk.body.includes('+added three'));
    },
  },
  {
    name: 'parseUnifiedDiff: ignores empty and binary diffs',
    run: (): void => {
      assert.deepEqual(parseUnifiedDiff(''), []);
      assert.deepEqual(parseUnifiedDiff('Binary files a/x.png and b/x.png differ'), []);
    },
  },
  {
    name: 'hunkId: stable when only line numbers change',
    run: (): void => {
      const [first] = parseUnifiedDiff(PATCH);
      const [shifted] = parseUnifiedDiff(PATCH.replace('@@ -1,4 +1,5 @@', '@@ -11,4 +11,5 @@'));
      if (first === undefined || shifted === undefined) {
        assert.fail('expected hunks');
      }
      assert.equal(hunkId('src/a.ts', first), hunkId('src/a.ts', shifted));
      assert.notEqual(hunkId('src/a.ts', first), hunkId('src/b.ts', first));
    },
  },
  {
    name: 'newFileHunks: splits long new files into paragraph-sized blocks',
    run: (): void => {
      const paragraph = [...Array.from({ length: 35 }).keys()].map((index) => `line ${String(index)}`).join('\n');
      const hunks = newFileHunks(`${paragraph}\n\n${paragraph}\n`);
      const [first, second] = hunks;
      if (first === undefined || second === undefined || hunks.length !== 2) {
        assert.fail('expected exactly two blocks');
      }
      assert.equal(first.startLine, 0);
      assert.equal(second.startLine, first.endLine + 1);
      assert.equal(hunks.reduce((sum, hunk) => sum + hunk.added, 0), 71);
    },
  },
];
