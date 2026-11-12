import * as vscode from 'vscode';
import type { AwsStartRequest } from './manager';
import { validRegion } from '../shared/aws/validation';
import { validateStart } from './startOptions';
const backendSetting = (value: unknown): value is AwsStartRequest['backend'] => value === 'auto' || value === 'host' || value === 'docker';

export const awsStartRequest = (): AwsStartRequest | undefined => {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder?.uri.scheme !== 'file') { return undefined; }
  const config = vscode.workspace.getConfiguration('malt.aws', folder.uri);
  const backend = config.get<unknown>('backend', 'auto');
  const port = config.get<unknown>('port', 4566);
  const bindAddress = config.get<unknown>('bindAddress', '127.0.0.1');
  const stateDirectory = config.get<unknown>('stateDirectory', '.malt/aws');
  const region = config.get<unknown>('region', 'us-east-1');
  if (!backendSetting(backend) || typeof port !== 'number'
    || typeof bindAddress !== 'string' || typeof stateDirectory !== 'string' || !validRegion(region)) {
    throw new Error('Invalid Local AWS settings.');
  }
  const request: AwsStartRequest = { workspaceRoot: folder.uri.fsPath, trusted: vscode.workspace.isTrusted, backend, port, bindAddress, stateDirectory, region };
  validateStart({ ...request, trusted: true });
  return request;
};
export const awsInjectionEnabled = (): boolean => vscode.workspace.getConfiguration('malt.aws').get<unknown>('terminal.inject', false) === true;
