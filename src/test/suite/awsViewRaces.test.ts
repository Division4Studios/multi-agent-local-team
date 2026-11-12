import assert from 'node:assert/strict';
import { AwsResourcesProvider } from '../../cloud/resourcesView';
import type { TestCase } from './harness';
import { FakeAdmin, queueValue, withAws } from './awsTestFixtures';
import type { Resources } from './awsTestFixtures';
import { drain, fulfilled, observe } from './awsAsyncFixture';
import type { Observed } from './awsAsyncFixture';
import { children, label, resourceIds } from './awsViewFixture';
import { deferred, waitFor } from './testUtils';

const assertNoObsoletePublication = async (view: AwsResourcesProvider): Promise<void> => {
  assert.ok(!(await resourceIds(view)).includes(queueValue('obsolete').id), 'an obsolete generation must not publish resources while the current response is gated');
  const roots = await children(view);
  const nodes = [...roots];
  for (const root of roots) { nodes.push(...await children(view, root)); }
  for (const node of nodes) {
    assert.doesNotMatch(label(await view.getTreeItem(node)), /error|fail|unavailable/iu, 'an obsolete generation must not publish a refresh error');
  }
};

export const tests: readonly TestCase[] = [
  {
    name: 'AWS tree generation: a stopped instance cannot repopulate resources from a late response',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        const view = new AwsResourcesProvider(f.manager);
        await view.refresh();
        const gate = deferred<Resources>();
        let entered = false;
        f.api.onResources = async (): Promise<Resources> => { entered = true; return await gate.promise; };
        const old = observe(view.refresh());
        try {
          await waitFor(() => entered, 'old resource read entered');
          await f.manager.stop();
          gate.resolve({ resources: [queueValue('obsolete')] });
          await drain([old]);
          assert.deepEqual(await resourceIds(view), []);
        } finally {
          gate.resolve({ resources: [queueValue('obsolete')] });
          await drain([old]);
        }
      });
    },
  },
  {
    name: 'AWS tree generation: obsolete success or failure stays unpublished while restarted current refresh is gated',
    run: async (): Promise<void> => {
      for (const fail of [false, true]) {
        await withAws(async f => {
          await f.manager.start(f.request);
          const view = new AwsResourcesProvider(f.manager);
          await view.refresh();
          const gate = deferred<undefined>();
          const currentGate = deferred<Resources>();
          let entered = false;
          f.api.onResources = async (): Promise<Resources> => {
            entered = true;
            await gate.promise;
            if (fail) { throw new Error('old resource failure'); }
            return { resources: [queueValue('obsolete')] };
          };
          const old = observe(view.refresh());
          const pending: Observed<unknown>[] = [old];
          try {
            await waitFor(() => entered, 'old resource read entered');
            await f.manager.stop();
            f.api = new FakeAdmin(f.calls);
            const current = queueValue('current');
            let currentEntered = false;
            f.api.onResources = async (): Promise<Resources> => { currentEntered = true; return await currentGate.promise; };
            await f.manager.start(f.request);
            const refreshing = observe(view.refresh());
            pending.push(refreshing);
            gate.resolve(undefined);
            await drain([old]);
            // A serialized provider can enter the current request only after the old one settles.
            await waitFor(() => currentEntered, 'current resource read entered');
            await assertNoObsoletePublication(view);
            currentGate.resolve({ resources: [current] });
            await fulfilled(refreshing);
            assert.deepEqual(await resourceIds(view), [current.id]);
            // Also prove a later successful refresh actually changes the current tree.
            const next = queueValue('current-next');
            f.api.onResources = undefined;
            f.api.resourcesValue = { resources: [next] };
            await view.refresh();
            assert.deepEqual(await resourceIds(view), [next.id]);
          } finally {
            gate.resolve(undefined);
            currentGate.resolve({ resources: [queueValue('current')] });
            await drain(pending);
          }
        });
      }
    },
  },
];
