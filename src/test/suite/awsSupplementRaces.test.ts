/** Public callback re-entry is deterministic; back-to-back updates do not force an out-of-order filesystem completion. */
import assert from 'node:assert/strict';
import type { TestCase } from './harness';
import { assertTarget, withInjection } from './awsSupplementInjectionFixture';
import { assertNoStalePublication } from './awsSupplementOracles';
import { drain, fulfilled, observe } from './awsAsyncFixture';
import type { Observed } from './awsAsyncFixture';

export const tests: readonly TestCase[] = [
  {
    name: 'AWS supplement injection latest-wins: back-to-back targets settle with the last profile and complete mutations',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        const next = { ...f.target, endpoint: 'http://127.0.0.1:14567', region: 'eu-west-3' };
        const last = { ...f.target, endpoint: 'http://127.0.0.1:14568', region: 'ap-southeast-7' };
        const older = Promise.allSettled([f.update(f.target), f.update(next)]);
        await f.update(last);
        await older;
        await assertTarget(f, last);
      });
    },
  },
  {
    name: 'AWS supplement injection latest-wins: a last invalid target leaves no mutations after earlier work settles',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        const older = Promise.allSettled([f.update(f.target)]);
        await assert.rejects(f.update({ ...f.target, region: 'bad\nregion' }));
        await older;
        assert.equal(f.collection.values.size, 0);
      });
    },
  },
  {
    name: 'AWS supplement injection latest-wins: immediate clear or disposal cannot be undone by an earlier update',
    run: async (): Promise<void> => {
      for (const dispose of [false, true]) {
        await withInjection(async f => {
          const older = Promise.allSettled([f.update(f.target)]);
          if (dispose) { f.dispose(); } else { await f.update(undefined); }
          assert.equal(f.collection.values.size, 0);
          await older;
          assert.equal(f.collection.values.size, 0);
        });
      }
    },
  },
  {
    name: 'AWS supplement injection re-entry: clear during publication cannot be followed by stale replacement callbacks',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        let clearing: Observed<void> | undefined;
        let immediateSize: number | undefined;
        let replacementsAtClear: number | undefined;
        f.collection.onReplace = (): void => {
          f.collection.onReplace = undefined;
          clearing = observe(f.update(undefined));
          immediateSize = f.collection.values.size;
          replacementsAtClear = f.collection.replacements.length;
        };
        await Promise.allSettled([f.update(f.target)]);
        assert.ok(clearing !== undefined, 'exercise the publication callback, not just an early validation failure');
        try { await fulfilled(clearing); } finally { await drain([clearing]); }
        assert.equal(immediateSize, 0);
        assertNoStalePublication(f.collection, replacementsAtClear);
      });
    },
  },
  {
    name: 'AWS supplement injection re-entry: disposal during publication permanently invalidates the older publisher',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        let immediateSize: number | undefined;
        let replacementsAtDispose: number | undefined;
        f.collection.onReplace = (): void => {
          f.collection.onReplace = undefined;
          f.dispose();
          immediateSize = f.collection.values.size;
          replacementsAtDispose = f.collection.replacements.length;
        };
        await Promise.allSettled([f.update(f.target)]);
        assert.equal(immediateSize, 0, 'disposal must be reached and clear synchronously');
        assertNoStalePublication(f.collection, replacementsAtDispose);
        await assert.rejects(f.update(undefined));
      });
    },
  },
];
