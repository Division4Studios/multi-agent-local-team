/**
 * Claude credentials for the reviewer, kept in VS Code SecretStorage (OS keychain), never in settings or files.
 * The Docker backend needs one: a long-lived OAuth token from `claude setup-token` (subscription) or an API key.
 * The host backend can also use the user's existing `claude` login.
 */
import * as vscode from 'vscode';

const OAUTH_KEY = 'malt.claude.oauthToken';
const API_KEY = 'malt.claude.apiKey';

export class Credentials {
  private readonly secrets: vscode.SecretStorage;

  public constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets;
  }

  /** Environment variables to pass to the reviewer, if credentials are stored. */
  public async env(): Promise<Record<string, string>> {
    const [oauthToken, apiKey] = await Promise.all([this.secrets.get(OAUTH_KEY), this.secrets.get(API_KEY)]);
    const env: Record<string, string> = {};
    if (oauthToken !== undefined) {
      env['CLAUDE_CODE_OAUTH_TOKEN'] = oauthToken;
    }
    if (apiKey !== undefined) {
      env['ANTHROPIC_API_KEY'] = apiKey;
    }
    return env;
  }

  public async hasAny(): Promise<boolean> {
    return Object.keys(await this.env()).length > 0;
  }

  public async promptAndStore(): Promise<boolean> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Claude subscription token', description: 'from `claude setup-token`', key: OAUTH_KEY },
        { label: 'Anthropic API key', description: 'billed per token', key: API_KEY },
      ],
      { title: 'MALT: Claude credentials for the reviewer' },
    );
    if (choice === undefined) {
      return false;
    }
    const value = await vscode.window.showInputBox({
      title: choice.label,
      prompt: 'Stored in your OS keychain via VS Code SecretStorage. Only passed to the MALT reviewer.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (text) => (text.trim() === '' ? 'Value is required' : undefined),
    });
    if (value === undefined) {
      return false;
    }
    await this.secrets.store(choice.key, value.trim());
    return true;
  }

  public async clear(): Promise<void> {
    await Promise.all([this.secrets.delete(OAUTH_KEY), this.secrets.delete(API_KEY)]);
  }
}
