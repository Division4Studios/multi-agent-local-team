import * as vscode from 'vscode';
import { feedVerifier } from './feedSignature';
export const agentConnections = (extension: vscode.Uri, key: Buffer): vscode.Disposable => {
  const args = (f: vscode.WorkspaceFolder): string[] => [
    vscode.Uri.joinPath(extension, 'out', 'architecture', 'agentBridge.js').fsPath,
    f.uri.fsPath,
    feedVerifier(key),
    ...(vscode.workspace.getConfiguration('malt.architecture').inspect<boolean>('shareAgentHandoffs')?.globalValue === true
      ? ['--share-handoffs']
      : []),
  ];
  const folders = (): readonly vscode.WorkspaceFolder[] =>
    vscode.workspace.isTrusted ? (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file') : [];
  const changed = new vscode.EventEmitter<void>();
  const provider = vscode.lm.registerMcpServerDefinitionProvider('malt.localAgents', {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => folders().map((f) => new vscode.McpStdioServerDefinition(`MALT · ${f.name}`, 'node', args(f))),
  });
  const copy = vscode.commands.registerCommand('malt.agentConnection', async () => {
    const available = folders();
    const folder =
      available.length === 1
        ? available[0]
        : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Workspace for local agents' });
    if (folder === undefined || !available.includes(folder)) {
      return;
    }
    await vscode.env.clipboard.writeText(JSON.stringify({ mcpServers: { malt: { command: 'node', args: args(folder) } } }, null, 2));
    void vscode.window.showInformationMessage('Copied the workspace connection, including its public verification key.');
  });
  return vscode.Disposable.from(
    copy,
    provider,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('malt.architecture.shareAgentHandoffs')) {
        changed.fire();
      }
    }),
    changed,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      changed.fire();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      changed.fire();
    }),
  );
};
