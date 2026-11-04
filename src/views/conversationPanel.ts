/**
 * "Live reviewer log": every model call the reviewer makes, streaming as it happens: what it is for, the model and
 * effort, the (secret-redacted) prompt, the answer as it is written, elapsed time, a stall indicator, and token
 * usage. Nothing is saved; closing the panel drops it.
 *
 * Security: events are validated by the client before they reach the page. The page has a strict CSP (no network;
 * only its own nonce-tagged script and style; resources limited to the extension's `media` folder), and its script
 * (`media/liveLog.js`) only ever sets `textContent`, so streamed text cannot inject markup or script.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ConversationEvent } from '../shared/conversation';

const RECONNECT_MS = 3_000;

const STYLE = `
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 0.6rem 1rem; border-bottom: 1px solid var(--vscode-panel-border); z-index: 1; }
header h1 { font-size: 1rem; margin: 0; } #status, #usage { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
#calls { padding: 0.5rem 1rem 2rem; }
.call { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin: 0.6rem 0; padding: 0.5rem 0.75rem; }
.head { display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap; }
.label { font-weight: 600; } .model, .time, .usage { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.usage { margin-top: 0.35rem; }
.state { font-size: 0.8em; padding: 0 0.45rem; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.state.ok { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
.state.err, .state.stalled { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
details { margin-top: 0.35rem; } summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
pre { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 0.85em; margin: 0.35rem 0 0; }
.prompt { max-height: 18rem; overflow: auto; color: var(--vscode-descriptionForeground); }
.error { color: var(--vscode-errorForeground); }`;

export type LiveLogMessage =
  | { readonly type: 'status'; readonly text: string }
  | { readonly type: 'event'; readonly event: ConversationEvent }
  | { readonly type: 'clear' };

/** What the connection needs from the reviewer manager (an interface, so tests can drive it). */
export interface LiveLogSource {
  readonly client: { readonly streamConversations: (onEvent: (event: ConversationEvent) => void, onClose: () => void) => () => void } | undefined;
  readonly status: { readonly state: string };
  readonly onDidChangeStatus: vscode.Event<{ readonly state: string }>;
}

/**
 * Keeps the log attached to the reviewer that is running now. It disconnects as soon as the reviewer leaves the
 * running state, reconnects when it (or a restarted instance) is running again, and retries a dropped stream while
 * the same reviewer is still running. A stream it closed on purpose never triggers a reconnect.
 */
export class LiveLogConnection implements vscode.Disposable {
  private readonly source: LiveLogSource;
  private readonly post: (message: LiveLogMessage) => void;
  private readonly reconnectMs: number;
  private readonly subscription: vscode.Disposable;
  private connectedTo: LiveLogSource['client'];
  private stop: (() => void) | undefined;
  private retry: NodeJS.Timeout | undefined;
  private disposed = false;

  public constructor(source: LiveLogSource, post: (message: LiveLogMessage) => void, reconnectMs = RECONNECT_MS) {
    this.source = source;
    this.post = post;
    this.reconnectMs = reconnectMs;
    this.subscription = source.onDidChangeStatus((status) => {
      if (status.state !== 'running') {
        this.disconnect(`The reviewer is ${status.state}. The log reconnects when it is running again.`);
      } else if (this.source.client !== this.connectedTo) {
        this.connect();
      }
    });
    this.connect();
  }

  public get connected(): boolean {
    return this.stop !== undefined;
  }

  public dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.subscription.dispose();
  }

  private connect(): void {
    this.disconnect();
    const client = this.source.client;
    if (client === undefined) {
      this.post({ type: 'status', text: 'The reviewer is not running. The log connects when it starts.' });
      return;
    }
    this.connectedTo = client;
    this.post({ type: 'clear' });
    this.post({ type: 'status', text: 'Connected · streaming live · secrets redacted · nothing is saved' });
    this.stop = client.streamConversations(
      (event) => {
        if (this.connectedTo === client) {
          this.post({ type: 'event', event });
        }
      },
      () => {
        // Only an unexpected drop of the current stream reconnects; a deliberate disconnect cleared connectedTo.
        if (this.disposed || this.connectedTo !== client) {
          return;
        }
        this.stop = undefined;
        this.connectedTo = undefined;
        this.post({ type: 'status', text: 'Disconnected from the reviewer · reconnecting…' });
        this.retry = setTimeout(() => {
          this.connect();
        }, this.reconnectMs);
      },
    );
  }

  private disconnect(message?: string): void {
    clearTimeout(this.retry);
    this.retry = undefined;
    const stop = this.stop;
    this.stop = undefined;
    this.connectedTo = undefined;
    stop?.();
    if (message !== undefined && !this.disposed) {
      this.post({ type: 'status', text: message });
    }
  }
}

const html = (nonce: string, scriptUri: vscode.Uri): string => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${STYLE}</style><title>MALT live reviewer log</title></head><body>
<header><h1>Live reviewer log</h1><div id="status">Connecting…</div><div id="usage"></div></header><div id="calls"></div>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script></body></html>`;

export class ConversationPanel implements vscode.Disposable {
  private static current: ConversationPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly connection: LiveLogConnection;
  private disposed = false;

  private constructor(source: LiveLogSource, extensionUri: vscode.Uri) {
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel('malt.conversations', 'MALT · Live reviewer log', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    const script = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'liveLog.js'));
    this.panel.webview.html = html(randomBytes(16).toString('hex'), script);
    this.connection = new LiveLogConnection(source, (message) => {
      void this.panel.webview.postMessage(message);
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  public static show(source: LiveLogSource, extensionUri: vscode.Uri): void {
    if (ConversationPanel.current === undefined) {
      ConversationPanel.current = new ConversationPanel(source, extensionUri);
    } else {
      ConversationPanel.current.panel.reveal(vscode.ViewColumn.Beside);
    }
  }

  public dispose(): void {
    // Disposing the webview fires onDidDispose, which calls this again; only clean up once.
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (ConversationPanel.current === this) {
      ConversationPanel.current = undefined;
    }
    this.connection.dispose();
    this.panel.dispose();
  }
}
