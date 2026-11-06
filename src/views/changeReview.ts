/** Before-commit workspace: inspect current evidence, then ask for an explanation on demand. */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { HunkStore } from '../review/hunkStore';
import type { ConsolidationCheck } from '../review/consolidation';
import type { StandardsModel } from '../standards/standardsModel';
import type { ReviewerClient } from '../review/reviewerClient';
import { isRecord, isString } from '../shared/guards';
import { workspaceFile } from '../editor/findingHighlight';
import { getGitApi } from '../git/gitApi';
import type { GitRepository } from '../git/gitApi';
import { changeDialogue, changeDiscussion, changePacket } from './changeReviewModel';
import type { ChangePacket, Verification } from './changeReviewModel';
import { reviewerTurn } from '../architecture/discussion';
import type { Turn } from '../architecture/discussion';
import { changeReviewState, ensureChangeReviewer } from './changeReviewState';

interface Deps {
  readonly store: HunkStore;
  readonly consolidation: ConsolidationCheck;
  readonly standards: StandardsModel;
  readonly extensionUri: vscode.Uri;
  readonly manager: { readonly client: ReviewerClient | undefined };
  readonly attention: { noteUserActivity: () => void };
  readonly pullRequest: () => unknown;
}

const html = (webview: vscode.Webview, extension: vscode.Uri): string => {
  const nonce = randomBytes(20).toString('hex');
  const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(extension, 'media', name)).toString();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
<link rel="stylesheet" href="${asset('maltTheme.css')}"/><link rel="stylesheet" href="${asset('changeReview.css')}"><title>Before commit</title></head><body>
<header><div class="eyebrow">MALT / HUMAN REVIEW</div><h1>Before commit</h1><p id="scope"></p><p id="freshness" role="status"></p>
<div class="actions"><button id="analyze">Explain these changes</button><button id="review">Run missing code reviews</button><button id="architecture">Explore architecture</button></div></header>
<section id="metrics" aria-label="Review status"></section><p id="queueStatus" role="status"></p>
<section class="brief"><div><h2>What changed — and why?</h2><p>Start with the change map, then ask for a plain-language explanation of the captured changes. A code review is not a test run.</p></div>
<div id="answer" aria-live="polite"><p class="muted">No AI summary requested yet. Opening this page does not make a model call.</p></div><div id="citations" class="actions" aria-label="Sources supplied to the explanation"></div></section>
<main><section class="map-pane"><div class="section-title"><h2>Where the changes are</h2><label>Filter files<input id="filter" type="search" placeholder="Name or folder"></label></div>
<p class="muted">Select a file to see its purpose, changed blocks and review results. Groups show folders, not runtime boundaries.</p><div id="fileMap"></div>
<h3>Changed connections</h3><p class="muted">Added and removed relative imports found in the captured patches. Other architectural changes may not appear here.</p><div id="connections"></div></section>
<aside><h2 id="selectedTitle">Choose a file</h2><div id="selected"><p class="muted">The inspector connects the explanation to the actual code.</p></div></aside></main>
<section class="attention"><h2>What needs attention?</h2><div id="findings"></div></section>
<section class="verification"><h2>Tests and verification</h2><p id="testStatus">No test results recorded. This panel has not run tests.</p><button id="openTests">Open VS Code Testing</button>
<details><summary>Record a result you observed</summary><p class="muted">This is a developer-reported result for these saved changes, not an independently verified test run.</p><label>Outcome<select id="testOutcome"><option value="passed">Passed</option><option value="failed">Failed</option><option value="not-run">Not run</option></select></label>
<label>Command or test suite, and what happened<textarea id="testNote" rows="2" maxlength="1600"></textarea></label><button id="recordTest">Record result</button></details></section>
<section class="dialogue"><h2>Ask about these changes</h2><p class="muted">Answers use the captured patches, available file summaries and recorded reviews. Missing evidence stays unknown.</p>
<div class="actions" id="suggestions"><button data-question="Explain the user-visible changes in plain English. Separate what the code shows from inferred intent.">What will users notice?</button><button data-question="Explain how responsibilities and connections changed. Name the files and distinguish evidence from hypotheses.">How did the architecture change?</button><button data-question="What should a human inspect before committing? Prioritize recorded failures and missing verification. Do not claim tests ran.">What should I check?</button></div>
<div id="thread" role="log" aria-live="polite"></div><form id="questionForm"><label>Your question<textarea id="question" rows="3" maxlength="1600" placeholder="For example: why were these files changed together?"></textarea></label><button id="ask" type="submit">Ask reviewer</button></form><p id="notice" role="status"></p></section>
<script nonce="${nonce}" src="${asset('changeReview.js')}"></script></body></html>`;
};

class ChangeReview implements vscode.Disposable {
  private readonly deps: Deps;
  private readonly folder: vscode.WorkspaceFolder;
  private readonly repository: GitRepository | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private last = '';
  private generation = 0;
  private busy = false;
  private closed = false;
  private turns: Turn[] = [];
  private verification: Verification | undefined;
  public constructor(deps: Deps, folder: vscode.WorkspaceFolder, repository: GitRepository | undefined) {
    this.deps = deps; this.folder = folder; this.repository = repository;
    this.panel = vscode.window.createWebviewPanel('malt.changeReview', 'Before commit', vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(deps.extensionUri, 'media')] });
    this.subscriptions.push(deps.store.onDidChange(() => { this.refresh(); }), deps.standards.onDidChange(() => { this.refresh(); }),
      deps.consolidation.onDidChange(() => { this.refresh(); }), this.panel.webview.onDidReceiveMessage((message: unknown) => { void this.receive(message); }),
      vscode.workspace.onDidChangeTextDocument(() => { this.refresh(); }), vscode.workspace.onDidCloseTextDocument(() => { this.refresh(); }),
      vscode.workspace.onDidSaveTextDocument(() => { this.refresh(); }));
    if (repository !== undefined) { this.subscriptions.push(repository.state.onDidChange(() => { this.refresh(); })); }
    this.panel.onDidDispose(() => { this.closed = true; this.generation++; vscode.Disposable.from(...this.subscriptions).dispose(); });
    this.panel.webview.html = html(this.panel.webview, deps.extensionUri);
  }
  public get visible(): boolean { return !this.closed; }
  public reveal(): void { this.panel.reveal(); }
  public dispose(): void { this.panel.dispose(); }
  private packet(): ChangePacket { return changePacket(this.deps.store, this.deps.standards.architecture?.modules ?? [], this.deps.consolidation.state.findings); }
  private environment(packet: ChangePacket): ReturnType<typeof changeReviewState> {
    return changeReviewState(this.folder.uri, packet.files, this.repository?.state, vscode.workspace.textDocuments);
  }
  private identity(packet: ChangePacket): string {
    return JSON.stringify([packet.revision, this.environment(packet).identity, this.deps.pullRequest() !== undefined]);
  }
  private post(message: unknown): void { if (!this.closed) { void this.panel.webview.postMessage(message); } }
  private refresh(): void {
    const packet = this.packet(), identity = this.identity(packet), changed = this.last !== '' && this.last !== identity;
    if (changed) { this.generation++; this.turns = []; this.verification = undefined; }
    this.last = identity;
    const environment = this.environment(packet);
    this.post({ type: 'state', packet, branch: this.repository?.state.HEAD?.name ?? 'Current workspace', workspace: this.folder.name, dirty: environment.dirty, changed,
      unrepresented: environment.unrepresented, consolidation: this.deps.consolidation.state.status, prActive: this.deps.pullRequest() !== undefined, verification: this.verification });
  }
  private async receive(value: unknown): Promise<void> {
    if (!isRecord(value)) { return; }
    this.deps.attention.noteUserActivity();
    try {
      if (value['action'] === 'ready') { this.refresh(); }
      else if (['open', 'architecture'].includes(String(value['action']))) { await this.open(value['path'], value['action'] === 'architecture'); }
      else if (value['action'] === 'ask') { await this.askValue(value['text']); }
      else if (value['action'] === 'recordTest') { this.recordVerification(value); }
      else if (value['action'] === 'review') { await this.runReviews(); }
      else if (value['action'] === 'tests') { await vscode.commands.executeCommand('workbench.view.testing.focus'); }
    } catch (error: unknown) { this.post({ type: 'notice', text: error instanceof Error ? error.message : String(error) }); }
  }
  private async askValue(value: unknown): Promise<void> { if (isString(value)) { await this.ask(value); } }
  private async reviewer(): Promise<ReviewerClient> {
    return await ensureChangeReviewer(() => this.deps.manager.client, async () => {
      this.post({ type: 'notice', text: 'Starting the reviewer…' });
      await vscode.commands.executeCommand('malt.startReviewer');
    });
  }
  private async runReviews(): Promise<void> {
    this.requireLocalChanges(this.packet());
    await this.reviewer();
    this.requireLocalChanges(this.packet());
    await vscode.commands.executeCommand('malt.reviewAll');
    this.post({ type: 'notice', text: 'Missing code reviews were requested. Current queue progress is shown above the change map.' });
    this.refresh();
  }
  private recordVerification(value: Record<string, unknown>): void {
    if (this.environment(this.packet()).dirty) { throw new Error('Save or discard unsaved edits before recording a verification result for this change.'); }
    const outcome = value['outcome'], note = value['note'];
    if (!isString(outcome) || !['passed', 'failed', 'not-run'].includes(outcome) || !isString(note) || note.length > 1600 || note.trim() === '') { return; }
    this.verification = { outcome, note: note.trim() };
    this.generation++; this.turns = [];
    this.post({ type: 'answerInvalidated', text: 'Verification evidence changed. Ask again to include the reported result.' });
    this.refresh();
  }
  private validSource(path: string, packet: ChangePacket): boolean {
    return packet.files.some((file) => file.path === path) || packet.imports.some((edge) => edge.to === path);
  }
  private async open(path: unknown, architecture: boolean): Promise<void> {
    if (!isString(path) || path === '') {
      if (architecture) { await vscode.commands.executeCommand('malt.showArchitecture'); }
      return;
    }
    const packet = this.packet();
    if (!this.validSource(path, packet)) { return; }
    const uri = await workspaceFile(this.folder, path);
    if (uri === undefined) { throw new Error('This source is no longer available inside the workspace.'); }
    if (architecture) {
      await vscode.commands.executeCommand('malt.openArchitectureView', this.folder.uri.toString(), { kind: 'architecture', key: '', item: `file:${path}` });
    } else {
      const line = (packet.files.find((file) => file.path === path)?.blocks[0]?.line ?? 1) - 1;
      await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: new vscode.Range(line, 0, line, 0) });
    }
  }
  private async ask(question: string): Promise<void> {
    if (this.busy || question.trim() === '' || question.length > 1600) { return; }
    const packet = this.packet();
    this.requireLocalChanges(packet);
    this.busy = true;
    const generation = this.generation, identity = this.identity(packet);
    this.post({ type: 'busy' });
    try {
      const client = await this.reviewer();
      const evidence = changeDiscussion(this.deps.store, packet);
      const history = this.turns.slice(-6), asked: Turn = { role: 'developer', text: question.trim() };
      const dialogue = changeDialogue(history, this.verification, asked.text);
      const answer = await client.discuss({ path: 'Before commit', source: evidence.source, context: evidence.context, dialogue });
      if (generation !== this.generation || identity !== this.identity(this.packet())) {
        this.post({ type: 'notice', text: 'The changes or recorded reviews changed while the answer was being prepared. Ask again for the current evidence.' });
        return;
      }
      this.turns = [...history, asked, reviewerTurn(answer)];
      this.post({ type: 'answer', question, answer, supplied: evidence.supplied, omitted: evidence.omitted });
    } finally { this.busy = false; this.post({ type: 'idle' }); }
  }
  private requireLocalChanges(packet: ChangePacket): void {
    if (this.deps.pullRequest() !== undefined) { throw new Error('A pull request checkout is active. Finish that review before reviewing local changes here.'); }
    if (packet.files.length === 0) { throw new Error('There are no tracked changes to explain yet. Save your changes and wait for Git tracking to refresh.'); }
  }
}

export const registerChangeReview = (deps: Deps): vscode.Disposable => {
  let panel: ChangeReview | undefined;
  const command = vscode.commands.registerCommand('malt.beforeCommit', async () => {
    deps.attention.noteUserActivity();
    const folder = deps.standards.workspaceFolder;
    if (folder === undefined || !vscode.workspace.isTrusted) { void vscode.window.showInformationMessage('Open a trusted workspace to review its local changes.'); return; }
    if (deps.pullRequest() !== undefined) { void vscode.window.showInformationMessage('Finish the active pull request review before opening Before commit for local changes.'); return; }
    if (panel?.visible === true) { panel.reveal(); return; }
    const git = await getGitApi();
    const repository = git?.repositories.find((candidate) => candidate.rootUri.toString() === folder.uri.toString());
    panel = new ChangeReview(deps, folder, repository);
  });
  return vscode.Disposable.from(command, new vscode.Disposable(() => { panel?.dispose(); }));
};
