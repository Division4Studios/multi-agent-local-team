import * as vscode from 'vscode';
import type { AwsManager } from './manager';

export const awsStatusBar = (manager: AwsManager): vscode.Disposable => {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 15);
  item.name = 'Local AWS Emulator';
  const update = (): void => {
    const status = manager.status;
    const icon = status.state === 'error' || status.state === 'unhealthy' ? 'warning' : 'cloud';
    item.text = `$(${icon}) Local AWS: ${status.state} · ${String(status.requestCount)}`;
    item.tooltip = `${status.detail}\nBackend: ${status.backend ?? 'none'}\nEndpoint: ${status.endpoint?.gatewayUrl ?? 'none'}`;
    item.command = status.state === 'stopped' ? 'malt.aws.start' : 'malt.aws.focus';
    item.accessibilityInformation = { label: `Local AWS ${status.state}, ${String(status.requestCount)} requests` };
    item.show();
  };
  update();
  return vscode.Disposable.from(item, manager.onDidChangeStatus(update));
};
