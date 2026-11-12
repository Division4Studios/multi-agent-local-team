import type * as vscode from 'vscode';
import { isRecord } from '../shared/guards';
import { exactKeys } from '../shared/aws/validation';

const KEY = 'malt.aws.dockerSocketConsent';
export class AwsSocketConsent {
  private readonly state: Pick<vscode.Memento, 'get' | 'update'>;
  public constructor(state: Pick<vscode.Memento, 'get' | 'update'>) { this.state = state; }
  public has(): boolean {
    const value = this.state.get<unknown>(KEY);
    return isRecord(value) && exactKeys(value, ['version', 'granted']) && value['version'] === 1 && value['granted'] === true;
  }
  public async grant(): Promise<void> { await this.state.update(KEY, { version: 1, granted: true }); }
}
