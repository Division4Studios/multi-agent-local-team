/**
 * "Live reviewer log": every model call the reviewer makes, streaming as it happens: what it is for, the prompt
 * it was given and the answer as it is written, with elapsed time and a stall indicator. Nothing is saved;
 * closing the panel drops it. The reviewer keeps a short in-memory backlog, so opening the log shows recent calls.
 *
 * Security: events are validated by the client before they reach the page. The page has a strict CSP (no network,
 * no external resources, only its own nonce-tagged script and style) and its script only ever sets `textContent`,
 * so streamed text from a reviewed repository cannot inject markup or script.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { ReviewerManager } from '../backend/reviewerManager';
import type { ConversationEvent } from '../shared/conversation';

const RECONNECT_MS = 3_000;

const STYLE = `
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; }
header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 0.6rem 1rem; border-bottom: 1px solid var(--vscode-panel-border); z-index: 1; }
header h1 { font-size: 1rem; margin: 0; } #status { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
#calls { padding: 0.5rem 1rem 2rem; }
.call { border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin: 0.6rem 0; padding: 0.5rem 0.75rem; }
.head { display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap; }
.label { font-weight: 600; } .model, .time { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
.state { font-size: 0.8em; padding: 0 0.45rem; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.state.ok { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); }
.state.err, .state.stalled { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
details { margin-top: 0.35rem; } summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 0.85em; }
pre { white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family); font-size: 0.85em; margin: 0.35rem 0 0; }
.prompt { max-height: 18rem; overflow: auto; color: var(--vscode-descriptionForeground); }
.error { color: var(--vscode-errorForeground); }`;

/* The page script. Plain DOM APIs and textContent only; no innerHTML, no eval, no network. */
const SCRIPT = `
(function () {
  var MAX_CALLS = 150, STALL_MS = 30000;
  var calls = new Map(), list = document.getElementById('calls'), status = document.getElementById('status');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text !== undefined) { e.textContent = text; } return e; }
  function nearBottom() { return window.innerHeight + window.scrollY >= document.body.scrollHeight - 80; }
  function secs(ms) { return Math.max(0, Math.round(ms / 1000)) + 's'; }
  function start(e) {
    var card = el('div', 'call'), head = el('div', 'head');
    var state = el('span', 'state', 'waiting for first token'), time = el('span', 'time', '');
    head.appendChild(el('span', 'label', e.label)); head.appendChild(el('span', 'model', e.model)); head.appendChild(state); head.appendChild(time);
    var details = el('details'); details.appendChild(el('summary', '', 'Prompt sent (' + e.prompt.length + ' characters)')); details.appendChild(el('pre', 'prompt', e.prompt));
    var answer = el('pre', 'answer', '');
    card.appendChild(head); card.appendChild(details); card.appendChild(answer);
    list.appendChild(card);
    calls.set(e.callId, { card: card, state: state, time: time, answer: answer, started: e.at, last: e.at, done: false });
    while (list.children.length > MAX_CALLS) { list.removeChild(list.firstChild); }
  }
  function text(e) { var c = calls.get(e.callId); if (!c) { return; } c.answer.textContent += e.text; c.last = e.at; c.state.textContent = 'streaming'; c.state.className = 'state'; }
  function end(e) {
    var c = calls.get(e.callId); if (!c) { return; }
    c.done = true; c.time.textContent = 'took ' + secs(e.at - c.started);
    c.state.textContent = e.ok ? 'done' : 'failed'; c.state.className = 'state ' + (e.ok ? 'ok' : 'err');
    if (!e.ok) { c.card.appendChild(el('pre', 'error', e.error)); }
  }
  window.addEventListener('message', function (message) {
    var data = message.data; if (!data || typeof data !== 'object') { return; }
    if (data.type === 'status') { status.textContent = String(data.text); return; }
    if (data.type === 'clear') { list.textContent = ''; calls.clear(); return; }
    if (data.type !== 'event' || !data.event) { return; }
    var stick = nearBottom(), e = data.event;
    if (e.kind === 'start') { start(e); } else if (e.kind === 'text') { text(e); } else if (e.kind === 'end') { end(e); }
    if (stick) { window.scrollTo(0, document.body.scrollHeight); }
  });
  setInterval(function () {
    var now = Date.now();
    calls.forEach(function (c) {
      if (c.done) { return; }
      c.time.textContent = 'running ' + secs(now - c.started);
      if (now - c.last > STALL_MS) { c.state.textContent = 'no output for ' + secs(now - c.last); c.state.className = 'state stalled'; }
    });
  }, 1000);
}());`;

const html = (nonce: string): string => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">${STYLE}</style><title>MALT live reviewer log</title></head><body>
<header><h1>Live reviewer log</h1><div id="status">Connecting…</div></header><div id="calls"></div>
<script nonce="${nonce}">${SCRIPT}</script></body></html>`;

export class ConversationPanel implements vscode.Disposable {
  private static current: ConversationPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly manager: ReviewerManager;
  private readonly disposables: vscode.Disposable[] = [];
  private stop: (() => void) | undefined;
  private retry: NodeJS.Timeout | undefined;
  private disposed = false;

  private constructor(manager: ReviewerManager) {
    this.manager = manager;
    this.panel = vscode.window.createWebviewPanel('malt.conversations', 'MALT · Live reviewer log', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    this.panel.webview.html = html(randomBytes(16).toString('hex'));
    this.disposables.push(
      this.panel.onDidDispose(() => {
        this.dispose();
      }),
      manager.onDidChangeStatus((status) => {
        if (status.state === 'running' && this.stop === undefined) {
          this.connect();
        }
      }),
    );
    this.connect();
  }

  public static show(manager: ReviewerManager): void {
    if (ConversationPanel.current === undefined) {
      ConversationPanel.current = new ConversationPanel(manager);
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
    clearTimeout(this.retry);
    this.stop?.();
    this.stop = undefined;
    vscode.Disposable.from(...this.disposables).dispose();
    this.panel.dispose();
  }

  private post(message: { readonly type: 'status'; readonly text: string } | { readonly type: 'event'; readonly event: ConversationEvent } | { readonly type: 'clear' }): void {
    void this.panel.webview.postMessage(message);
  }

  /** Connects while the reviewer is running; on disconnect, retries every few seconds while the panel is open. */
  private connect(): void {
    clearTimeout(this.retry);
    const client = this.manager.client;
    if (client === undefined) {
      this.post({ type: 'status', text: 'The reviewer is not running. The log connects when it starts.' });
      return;
    }
    this.post({ type: 'clear' });
    this.post({ type: 'status', text: 'Connected · streaming live · nothing is saved' });
    this.stop = client.streamConversations(
      (event) => {
        this.post({ type: 'event', event });
      },
      () => {
        this.stop = undefined;
        if (this.disposed) {
          return;
        }
        this.post({ type: 'status', text: 'Disconnected from the reviewer · reconnecting…' });
        this.retry = setTimeout(() => {
          this.connect();
        }, RECONNECT_MS);
      },
    );
  }
}
