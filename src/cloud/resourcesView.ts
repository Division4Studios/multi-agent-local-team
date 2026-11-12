import * as vscode from 'vscode';
import type { AwsQueueResource } from '../shared/aws/types';
import type { AwsManager } from './manager';

type Node = { readonly kind: 'status' | 'error' } | { readonly kind: 'service'; readonly service: 'sqs' | 'sts' }
  | { readonly kind: 'queue'; readonly resource: AwsQueueResource };

export class AwsResourcesProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly manager: Pick<AwsManager, 'status' | 'client' | 'onDidChangeStatus'>;
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  public readonly onDidChangeTreeData = this.changed.event;
  private readonly listener: vscode.Disposable;
  private resources: readonly AwsQueueResource[] = [];
  private error = false;
  private generation = 0;
  private disposed = false;
  public constructor(manager: Pick<AwsManager, 'status' | 'client' | 'onDidChangeStatus'>) {
    this.manager = manager;
    this.listener = manager.onDidChangeStatus(status => {
      if (status.state !== 'running') { this.generation += 1; this.resources = []; this.error = false; }
      this.changed.fire(undefined);
    });
  }
  public getTreeItem(node: Node): vscode.TreeItem | Thenable<vscode.TreeItem> {
    if (node.kind === 'queue') { return queueItem(node.resource); }
    if (node.kind === 'service') {
      const item = new vscode.TreeItem(node.service.toUpperCase(), node.service === 'sqs' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.id = `aws:service:${node.service}`;
      item.iconPath = new vscode.ThemeIcon(node.service === 'sqs' ? 'list-unordered' : 'shield');
      item.description = node.service === 'sqs' ? `${String(this.resources.length)} queues` : 'GetCallerIdentity';
      return item;
    }
    const status = this.manager.status;
    const item = new vscode.TreeItem(node.kind === 'error' ? 'Resources unavailable: refresh failed' : `Local AWS: ${status.state}`);
    item.id = `aws:${node.kind}`;
    item.iconPath = new vscode.ThemeIcon(node.kind === 'error' || ['error', 'unhealthy'].includes(status.state) ? 'warning' : 'cloud');
    item.tooltip = node.kind === 'error' ? 'Refresh to retry loading Local AWS resources.' : status.detail;
    return item;
  }
  public getChildren(node?: Node): vscode.ProviderResult<Node[]> {
    if (node === undefined) {
      return [{ kind: 'status' }, ...(this.error ? [{ kind: 'error' }] satisfies Node[] : []),
        { kind: 'service', service: 'sqs' }, { kind: 'service', service: 'sts' }];
    }
    return node.kind === 'service' && node.service === 'sqs' ? this.resources.map(resource => ({ kind: 'queue', resource })) : [];
  }
  public async refresh(): Promise<void> {
    const generation = ++this.generation;
    const client = this.manager.client;
    this.resources = [];
    this.error = false;
    const current = (): boolean => !this.disposed && generation === this.generation && this.manager.client === client;
    if (client === undefined) { this.changed.fire(undefined); return; }
    try {
      const result = await client.resources();
      if (current()) { this.resources = result.resources; }
    } catch { if (current()) { this.error = true; } }
    if (current()) { this.changed.fire(undefined); }
  }
  public dispose(): void {
    this.disposed = true; this.generation += 1; this.resources = [];
    this.listener.dispose(); this.changed.dispose();
  }
}

const queueItem = (resource: AwsQueueResource): vscode.TreeItem => {
  const item = new vscode.TreeItem(resource.name);
  item.id = `aws:queue:${resource.id}`;
  item.iconPath = new vscode.ThemeIcon('list-unordered');
  item.description = `${resource.account} / ${resource.region}`;
  const counts = resource.details.messageCounts;
  item.tooltip = `${resource.id}\n${String(counts.available)} available, ${String(counts.delayed)} delayed, ${String(counts.inFlight)} in flight`;
  item.command = { command: 'malt.aws.openResource', title: 'Open Local AWS queue', arguments: [resource] };
  item.contextValue = 'malt.aws.queue';
  return item;
};
