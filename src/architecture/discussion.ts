import type { Diagram } from '../shared/diagram';
import { isSourceCodePath } from '../reviewer/standardsSources';
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { isRecord, isString } from '../shared/guards';
import type { Interpretation, Understanding } from '../shared/understanding';
import type { ReviewerClient } from '../review/reviewerClient';
import { digest } from './extract';
import type { MapNode, Snapshot } from './graph';
import { saveNote } from './knowledge';
import { headOf, workingReader } from './sources';
import type { MapTracker } from './tracker';

export type ReviewerAccess = () => Promise<ReviewerClient | undefined>;
interface Context {
  readonly tracker: MapTracker;
  readonly file: MapNode;
  readonly snapshot: Snapshot;
  readonly focus: MapNode;
  readonly panel?: string;
}
const initial = (context: Context): Interpretation => context.file.understanding ?? {
  what: 'This file has no agent interpretation yet.', why: 'Its design intent is unknown.',
  whatEvidence: '', whyEvidence: '', question: `What responsibility does ${context.focus.label} own, and why is it implemented here?`,
};
/**
 * One dialogue turn. MALT sets the role and the dialogue is sent as JSON, so text the model wrote earlier is
 * always attributed to the reviewer and can never pose as something the developer said.
 */
export type Turn =
  | { readonly role: 'developer'; readonly text: string }
  | { readonly role: 'reviewer'; readonly interpretation: Interpretation };
const MAX_TURNS = 16;
const MAX_DIALOGUE = 22_000;
/** Drops the oldest whole turns until the dialogue fits, so it is always valid JSON. */
export const dialogueOf = (turns: readonly Turn[]): string => {
  let kept = turns.slice(-MAX_TURNS);
  let text = JSON.stringify(kept);
  while (text.length > MAX_DIALOGUE && kept.length > 0) {
    kept = kept.slice(1);
    text = JSON.stringify(kept);
  }
  return text;
};
/** An answer replayed as the reviewer's own earlier, unverified interpretation (never as the developer's words). */
export const reviewerTurn = (answer: Interpretation): Turn => ({
  role: 'reviewer',
  interpretation: { what: answer.what, whatEvidence: answer.whatEvidence, why: answer.why, whyEvidence: answer.whyEvidence, question: answer.question },
});
const checkedSource = async (context: Context): Promise<string> => {
  const { tracker, file, snapshot } = context;
  const source = await workingReader(tracker.folder)(file.path);
  if (source === undefined || digest(source.replaceAll('\r\n', '\n')) !== file.hash || headOf(tracker.repository).branch !== snapshot.branch) {
    throw new Error('The file or branch changed. Reopen the discussion from the current map.');
  }
  return isSourceCodePath(file.path) ? source : context.panel ?? '';
};

const graphContext = ({ snapshot, file, focus }: Context): string => {
  const own = new Set(snapshot.nodes.filter((n) => n.path === file.path).map((n) => n.id));
  const nearby = snapshot.edges.filter((e) => own.has(e.from) || own.has(e.to)).slice(0, 40);
  return JSON.stringify({ selected: focus.label, file: file.path, understanding: file.understanding, relationships: nearby }).slice(0, 12_000);
};

const html = (view: vscode.Webview, media: vscode.Uri): string => {
  const nonce = randomBytes(20).toString('hex');
  const asset = (path: string): string => view.asWebviewUri(vscode.Uri.joinPath(media, path)).toString();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${view.cspSource};">
<link rel="stylesheet" href="${asset('architecture.css')}"><title>Architecture discussion</title></head><body>
<header><div class="kicker">MALT / ARCHITECTURE DISCUSSION</div><h1 id="subject">Clarify understanding</h1><p id="scope"></p></header>
<main><div id="thread" role="log" aria-live="polite"></div><form id="replyForm"><label>Your perspective
<textarea id="reply" rows="3" maxlength="1600" placeholder="Explain the intent, correct an assumption, or ask for evidence."></textarea></label>
<button id="send">Send to reviewer</button></form><p id="notice" role="status"></p>
<section><h2>Developer clarification</h2><p>Edit the statement you want MALT to remember for this file on this branch.</p>
<label>Statement to save<textarea id="proposal" rows="3" maxlength="1600"></textarea></label><button id="apply">Apply to architecture map</button></section>
</main><script nonce="${nonce}" src="${asset('architectureChat.js')}"></script></body></html>`;
};

class Discussion {
  private readonly panel: vscode.WebviewPanel;
  private readonly context: Context;
  private readonly reviewer: ReviewerAccess;
  private answer: Interpretation;
  private turns: readonly Turn[] = [];
  private busy = false;
  private closed = false;
  public constructor(media: vscode.Uri, context: Context, reviewer: ReviewerAccess) {
    this.context = context;
    this.reviewer = reviewer;
    this.answer = initial(context);
    this.panel = vscode.window.createWebviewPanel('malt.architectureChat', `Clarify · ${context.focus.label}`, vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
    const listener = this.panel.webview.onDidReceiveMessage((m: unknown) => { void this.receive(m); });
    this.panel.onDidDispose(() => { this.closed = true; listener.dispose(); });
    this.panel.webview.html = html(this.panel.webview, media);
  }
  private post(message: unknown): void {
    if (!this.closed) {
      void this.panel.webview.postMessage(message);
    }
  }
  private async receive(m: unknown): Promise<void> {
    if (this.busy || !isRecord(m)) {
      return;
    }
    this.busy = true;
    try {
      if (m['action'] === 'ready') {
        this.post({ type: 'initial', file: this.context.file.path, branch: this.context.snapshot.branch, answer: this.answer });
        if (this.context.file.understanding === undefined) {
          await this.ask('Analyze this code and ask the developer about anything the implementation cannot establish.');
        }
      } else if (isString(m['text']) && m['text'].trim() !== '' && m['text'].length <= 1600) {
        await this.handleText(m['action'], m['text'].trim());
      }
    } catch (error: unknown) {
      this.post({ type: 'notice', text: String(error) });
    } finally {
      this.busy = false;
      this.post({ type: 'idle' });
    }
  }
  private async handleText(action: unknown, text: string): Promise<void> {
    if (action === 'send') {
      await this.ask(text);
    } else if (action === 'save') {
      await checkedSource(this.context);
      const { file, tracker, snapshot } = this.context;
      const note: Understanding = { ...file.understanding, ...this.answer, confirmed: text };
      await saveNote(tracker.folder.uri.fsPath, { key: tracker.noteKey, branch: snapshot.branch, file }, note, () => !this.closed);
      tracker.refresh();
      this.post({ type: 'notice', text: 'Clarification saved to the branch map and reviewer context.' });
    }
  }
  private async ask(text: string): Promise<void> {
    const source = await checkedSource(this.context);
    this.post({ type: 'busy' });
    const client = await this.reviewer();
    if (client === undefined || this.closed) {
      throw new Error('The reviewer is unavailable. You can still record your own clarification below.');
    }
    const turns = [...this.turns, reviewerTurn(this.answer), { role: 'developer', text } satisfies Turn];
    const start = Math.max(0, this.context.focus.line - 16);
    const excerpt = source.length <= 48_000 ? source : source.split('\n').slice(start).join('\n').slice(0, 48_000);
    const answer = await client.discuss({ path: this.context.file.path, source: excerpt, context: [this.context.panel ?? '',graphContext(this.context)].join('\n').slice(0,12_000), dialogue: dialogueOf(turns) });
    this.turns = turns.slice(-MAX_TURNS);
    this.answer = answer;
    this.post({ type: 'answer', answer });
  }
}
interface FocusedPanel { readonly node:MapNode; readonly diagram:Diagram; readonly item:string }
export const openDiscussion = (media: vscode.Uri, tracker: MapTracker, selection: MapNode | FocusedPanel, reviewer: ReviewerAccess): void => {
  const node='node' in selection?selection.node:selection;
  const panel='diagram' in selection?JSON.stringify({kind:selection.diagram.kind,title:selection.diagram.title,selected:selection.item,items:selection.diagram.items.slice(0,60).map(i=>({id:i.id,label:i.label,role:i.group})),links:selection.diagram.links.slice(0,90)}).slice(0,7000):undefined;
  const snapshot = tracker.snapshot;
  const file = snapshot?.nodes.find((n) => n.kind === 'file' && n.path === node.path);
  if (snapshot !== undefined && file !== undefined && (isSourceCodePath(file.path)||panel!==undefined)) {
    new Discussion(media, { tracker, snapshot, file, focus: node, ...(panel===undefined?{}:{panel}) }, reviewer);
  }
};
