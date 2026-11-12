import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { AwsDocuments } from '../../cloud/documents';
import { AwsResourcesProvider } from '../../cloud/resourcesView';
import { isRecord } from '../../shared/guards';
import type { TestCase } from './harness';
import { coverageValue, queueValue, tracesValue, withAws } from './awsTestFixtures';
import { drain, observe } from './awsAsyncFixture';
import { children, label, queueIds, resourceIds, serviceNode } from './awsViewFixture';

export const tests: readonly TestCase[] = [
  {
    name: 'AWS native tree: status/service labels and product icons remain stable across refresh and state changes',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const view = new AwsResourcesProvider(f.manager);
        const before = await Promise.all((await children(view)).map(async node => await view.getTreeItem(node)));
        const stopped = before.find(item => /stopped/iu.test(label(item)));
        assert.ok(stopped !== undefined && typeof stopped.id === 'string');
        const statusId = stopped.id;
        assert.ok(before.every(item => typeof item.id === 'string' && item.iconPath instanceof vscode.ThemeIcon && label(item).length > 0));
        const services = [await serviceNode(view, 'sqs'), await serviceNode(view, 'sts')];
        const ids = await Promise.all(services.map(async node => (await view.getTreeItem(node)).id));
        await f.manager.start(f.request);
        await view.refresh();
        const running = await Promise.all((await children(view)).map(async node => await view.getTreeItem(node)));
        assert.ok(running.some(item => item.id === statusId && /running/iu.test(label(item))));
        const next = [await serviceNode(view, 'sqs'), await serviceNode(view, 'sts')];
        assert.deepEqual(await Promise.all(next.map(async node => (await view.getTreeItem(node)).id)), ids);
        assert.deepEqual(await children(view, await serviceNode(view, 'sts')), []);
        await f.manager.stop();
        await drain([observe(Promise.resolve().then(async () => { await view.refresh(); }))]);
        const final = await Promise.all((await children(view)).map(async node => await view.getTreeItem(node)));
        assert.ok(final.some(item => item.id === statusId && /stopped/iu.test(label(item))));
        assert.deepEqual(await resourceIds(view), []);
      });
    },
  },
  {
    name: 'AWS native tree: queue IDs depend on scoped resource identity, never order, counts or advertised port',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        const queues = [queueValue(), queueValue('orders', 'eu-west-3'), queueValue('orders', 'us-east-1', '123456789012')];
        f.api.resourcesValue = { resources: queues };
        const view = new AwsResourcesProvider(f.manager);
        const focused = vscode.window.activeTextEditor;
        await view.refresh();
        const before = await queueIds(view);
        assert.equal(before.size, 3);
        f.api.resourcesValue = { resources: [...queues].reverse().map(queue => ({
          ...queue, details: { ...queue.details, queueUrl: queue.details.queueUrl.replace(':4566/', ':4567/'), messageCounts: { available: 100, delayed: 0, inFlight: 0 } },
        })) };
        await view.refresh();
        assert.deepEqual(await queueIds(view), before);
        assert.equal(vscode.window.activeTextEditor, focused, 'background refresh must not take editor focus');
        const first = (await children(view, await serviceNode(view, 'sqs')))[0];
        assert.ok(first !== undefined);
        const args: readonly unknown[] | undefined = (await view.getTreeItem(first)).command?.arguments;
        const argument = args?.[0];
        assert.ok(isRecord(argument));
        const expected = f.api.resourcesValue.resources.find(queue => queue.id === argument['id']);
        assert.ok(expected !== undefined);
        assert.deepEqual(argument, expected);
      });
    },
  },
  {
    name: 'AWS native tree: failed refresh clears stale resource rows and exposes a textual error',
    run: async (): Promise<void> => {
      await withAws(async f => {
        await f.manager.start(f.request);
        const view = new AwsResourcesProvider(f.manager);
        await view.refresh();
        assert.equal((await queueIds(view)).size, 1);
        f.api.onResources = async (): Promise<never> => await Promise.reject(new Error('PRIVATE-RESPONSE-BODY'));
        await view.refresh().catch(() => undefined);
        const roots = await children(view);
        const nodes = [...roots];
        for (const root of roots) {
          nodes.push(...await children(view, root));
        }
        const items = await Promise.all(nodes.map(async node => await view.getTreeItem(node)));
        assert.ok(!items.some(item => item.command?.command === 'malt.aws.openResource'));
        assert.ok(items.some(item => /error|fail|unavailable/iu.test(label(item))));
        assert.ok(items.every(item => !label(item).includes('PRIVATE-RESPONSE-BODY')));
      });
    },
  },
  {
    name: 'AWS documents: validated resource, coverage and traces produce JSON via a native content provider',
    run: (): void => {
      const documents = new AwsDocuments();
      const nativeProvider: vscode.TextDocumentContentProvider = documents;
      assert.equal(typeof nativeProvider.provideTextDocumentContent, 'function');
      const entries: readonly (readonly ['resource' | 'coverage' | 'traces', ReturnType<typeof queueValue> | ReturnType<typeof coverageValue> | ReturnType<typeof tracesValue>])[] = [
        ['resource', queueValue()], ['coverage', coverageValue()], ['traces', tracesValue()],
      ];
      try {
        for (const [kind, value] of entries) {
          const uri = documents.add(kind, value);
          assert.equal(uri.scheme, 'malt-aws');
          const parsed: unknown = JSON.parse(documents.provideTextDocumentContent(uri));
          assert.deepEqual(parsed, value);
        }
      } finally {
        documents.dispose();
      }
    },
  },
  {
    name: 'AWS documents: secret-bearing extras are rejected before entering the document cache',
    run: (): void => {
      const documents = new AwsDocuments();
      const invalid = { ...queueValue(), token: 'not-for-display' };
      try { assert.throws(() => documents.add('resource', invalid)); } finally { documents.dispose(); }
    },
  },
];
