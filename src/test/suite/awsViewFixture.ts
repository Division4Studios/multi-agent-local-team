import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { AwsResourcesProvider } from '../../cloud/resourcesView';
import { isRecord } from '../../shared/guards';

export type ViewNode = NonNullable<Awaited<ReturnType<AwsResourcesProvider['getChildren']>>>[number];
export const children = async (view: AwsResourcesProvider, parent?: ViewNode): Promise<ViewNode[]> => [...await view.getChildren(parent) ?? []];
export const label = (item: vscode.TreeItem): string => typeof item.label === 'string' ? item.label : item.label?.label ?? '';

export const serviceNode = async (view: AwsResourcesProvider, service: string): Promise<ViewNode> => {
  for (const node of await children(view)) {
    if (label(await view.getTreeItem(node)).toLowerCase().includes(service)) { return node; }
  }
  return assert.fail(`missing native ${service} row`);
};

export const queueIds = async (view: AwsResourcesProvider): Promise<Map<string, string>> => {
  const ids = new Map<string, string>();
  const parent = await serviceNode(view, 'sqs');
  for (const node of await children(view, parent)) {
    const item = await view.getTreeItem(node);
    const command = item.command;
    assert.ok(command !== undefined);
    assert.equal(command.command, 'malt.aws.openResource');
    const args: readonly unknown[] | undefined = command.arguments;
    const queue = args?.[0];
    assert.ok(isRecord(queue) && typeof queue['id'] === 'string');
    assert.ok(typeof item.id === 'string' && item.id.length > 0);
    assert.ok(item.iconPath instanceof vscode.ThemeIcon);
    assert.ok(label(item).length > 0);
    ids.set(queue['id'], item.id);
  }
  assert.equal(new Set(ids.values()).size, ids.size, 'scoped queues cannot alias tree IDs');
  return ids;
};

/** Error/status rows may occur at either level; collect only public resource command arguments. */
export const resourceIds = async (view: AwsResourcesProvider): Promise<unknown[]> => {
  const roots = await children(view);
  const nodes = [...roots];
  for (const root of roots) { nodes.push(...await children(view, root)); }
  const ids: unknown[] = [];
  for (const node of nodes) {
    const command = (await view.getTreeItem(node)).command;
    if (command?.command !== 'malt.aws.openResource') { continue; }
    const args: readonly unknown[] | undefined = command.arguments;
    const resource = args?.[0];
    assert.ok(isRecord(resource));
    ids.push(resource['id']);
  }
  return ids;
};
