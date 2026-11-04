import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { GitApi } from '../git/gitApi';
import { workspaceFile } from '../editor/findingHighlight';
import { isRecord, isString } from '../shared/guards';
import { loadArchitecture } from '../reviewer/workspace';
import { architecturePage } from '../standards/standardsPages';
import { showListPage } from '../views/detailPanel';
import { compareGraphs } from './graph';
import type { MapNode, Snapshot } from './graph';
import { eligible, revision, revisionReader } from './sources';
import type { MapHead } from './sources';
import { openDiscussion } from './discussion';
import type { ReviewerAccess } from './discussion';
import { agentConnections } from './agentConnections';
import { Atlas } from './navigation';
import { AtlasTree } from './atlasTree';
import { finalizeFile } from './finalize';
import { handleView, parsePlace, selectedSource, sendView } from './viewBridge';
import { MapTracker } from './tracker';

const page = (webview: vscode.Webview, media: vscode.Uri): string => {
  const nonce = randomBytes(20).toString('hex');
  const resource = (file: string): string => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Architecture map</title>
<link rel="stylesheet" href="${resource('architecture.css')}"><link rel="stylesheet" href="${resource('perspectives.css')}"></head><body>
<header><div class="kicker">MALT / ARCHITECTURE</div><h1 id="title">Project map</h1><p id="status" role="status">Indexing…</p>
<div class="tools"><button id="compare">Compare branches…</button><button id="live">Working tree</button><button id="refresh">Rebuild map</button>
<button id="summaries">File summaries</button></div></header>
<section id="modelNav"><div class="tools"><label>View<select id="modelKind"></select></label><label>Subject<select id="modelSubject"></select></label>
<button id="modelBack">Previous view</button><button id="modelTray">Reveal in sidebar</button><button id="modelSide" hidden>Switch branch side</button><button id="modelExport">Finalize and export</button></div><button id="modelPrompt">Copy panel question</button><p id="modelQuestion"></p><nav id="relatedModels" aria-label="Related views"></nav></section>
<main id="modelScreen" hidden><div class="tools"><label>Search items<input type="search" id="modelSearch"></label><label>Zoom<select id="modelZoom"><option>1</option><option>1.5</option><option>2</option><option>0.75</option></select></label><select id="modelZone" aria-label="Timezone"><option>UTC</option><option>Local</option></select><label id="modelFieldsWrap"><input type="checkbox" id="modelFields" checked>Show members</label>
<button id="modelUp">Parent</button><button id="modelPlay">Play route</button><label><input type="checkbox" id="modelStill">Still</label></div><p id="modelRoute"></p><div id="modelDrawing"><svg id="modelSvg" role="group" aria-label="Interactive model"></svg></div>
<div class="tools"><button id="modelPrev">Previous items</button><span id="modelCount" role="status"></span><button id="modelNext">Next items</button></div><p id="modelLegend"></p><section id="modelDetail"></section></main>
<main id="connectionMap"><div class="filters"><label>Find a file or symbol <input type="search" id="search" placeholder="Name or path"></label>
<label>Tag <select id="tags"><option value="">All tags</option></select></label>
<label>Connections <select id="relation"><option value="">All connections</option><option>structure</option><option>imports</option>
<option>inherits</option><option>implements</option><option>calls</option><option>renders</option></select></label>
<label id="diffFilter" hidden><input type="checkbox" id="changed"> Changes only</label></div>
<div id="matches" aria-label="Search results"></div>
<nav><button id="back">Back</button><div id="crumbs" aria-label="Breadcrumb"></div></nav>
<div class="canvas"><svg id="map" aria-label="Interactive architecture map" role="group"></svg></div>
<div class="tools"><button id="less">Previous connections</button><span id="pages"></span><button id="more">Next connections</button>
<button id="zoomOut" aria-label="Zoom out">−</button><button id="zoomIn" aria-label="Zoom in">+</button><button id="fit">Fit</button></div>
<section aria-label="Architectural understanding"><h2>Architectural understanding</h2><div id="knowledge"></div>
<button id="clarify" hidden>Discuss or clarify with reviewer…</button></section>
<section aria-label="Trace a process"><h2>Trace a process</h2><p>Choose a start, then navigate or search for a destination.</p>
<div class="tools"><button id="traceStart">Start here</button><button id="traceEnd" disabled>Find path to here</button>
<label id="traceVersion" hidden>Trace in <select id="traceSide"><option value="target">Target</option><option value="base">Base</option></select></label>
<button id="traceClear" hidden>Clear trace</button></div><div id="trail" aria-live="polite"></div></section>
<section><h2 id="detail">Project</h2><p id="evidence"></p><button id="source" hidden>Open source</button></section></main>
<script nonce="${nonce}" src="${resource('perspectiveDrawing.js')}"></script><script nonce="${nonce}" src="${resource('perspectives.js')}"></script><script nonce="${nonce}" src="${resource('architecture.js')}"></script></body></html>`;
};

interface Comparison { readonly base: Snapshot; readonly target?: Snapshot }
interface Choice extends vscode.QuickPickItem { readonly head?: MapHead }
const label = (map: Snapshot): string => map.commit === '' ? map.branch : `${map.branch} @ ${map.commit.slice(0, 8)}`;
const present = async (document: vscode.TextDocument, node: MapNode): Promise<void> => {
  const position = new vscode.Position(Math.max(0, Math.min(node.line, document.lineCount) - 1), 0);
  await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position), preview: true, viewColumn: vscode.ViewColumn.Beside });
};

const viewMessage = (map: Snapshot | undefined, skipped: number, status: string): string => {
  const info = map === undefined ? '' : `${map.nodes.length.toLocaleString()} nodes · ${map.edges.length.toLocaleString()} relationships`;
  return [info, skipped === 0 ? '' : `${String(skipped)} source files skipped across displayed snapshots`, status].filter(Boolean).join(' · ');
};
const viewTitle = (map: Snapshot | undefined, comparison: Comparison | undefined, fallback: string): string => {
  const suffix = comparison?.target === undefined ? ' (working tree)' : '';
  const target = map === undefined ? fallback : label(map) + suffix;
  return comparison === undefined ? target : `${label(comparison.base)} → ${target}`;
};

class MapPanel {
  private readonly atlas: Atlas;
  private readonly tray: AtlasTree;
  private readonly tracker: MapTracker;
  private readonly media: vscode.Uri;
  private readonly reviewer: ReviewerAccess;
  private readonly panel: vscode.WebviewPanel;
  private comparison: Comparison | undefined;
  private sequence = 0;
  private readonly subscriptions: vscode.Disposable[] = [];
  private closed = false;
  public constructor(atlas: Atlas, tray: AtlasTree, media: vscode.Uri, reviewer: ReviewerAccess) {
    this.atlas = atlas; this.tray = tray;
    const tracker = atlas.tracker;
    this.media = media;
    this.reviewer = reviewer;
    this.tracker = tracker;
    this.panel = vscode.window.createWebviewPanel('malt.architecture', `Architecture · ${tracker.folder.name}`, vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [media], retainContextWhenHidden: true });
    this.subscriptions.push(atlas.onChange(() => { sendView(atlas,this.panel.webview); }), tracker.onDidChange(() => { this.render(); }), this.panel.webview.onDidReceiveMessage((message: unknown) => {
      void this.receive(message).catch((error: unknown) => { void vscode.window.showErrorMessage(`MALT: ${String(error)}`); });
    }));
    this.panel.onDidDispose(() => {
      this.closed = true;
      vscode.Disposable.from(...this.subscriptions).dispose();
    });
    this.panel.webview.html = page(this.panel.webview, media);
  }
  public get visible(): boolean { return !this.closed; }
  public reveal(): void { this.panel.reveal(); }
  public dispose(): void { this.panel.dispose(); }
  private async receive(message: unknown): Promise<void> {
    if (!isRecord(message)) {
      return;
    }
    switch (message['action']) {
      case 'ready': this.render(); break;
      case 'compare': await this.compare(); break;
      case 'live': this.sequence++; this.comparison = undefined; this.atlas.compare(); this.render(); break;
      case 'refresh': this.tracker.refresh(); break;
      case 'summaries': showListPage(architecturePage(await loadArchitecture(this.tracker.folder.uri.fsPath))); break;
      case 'clarify': this.clarify(message['id']); break;
      case 'source': if (isString(message['id'])) { await this.openSource(message['id']); } break;
      default: await handleView(this.atlas,message,{
        tray:async () => { await this.tray.reveal(this.atlas); },
        discuss:() => { const n=selectedSource(this.atlas); const diagram=this.atlas.model; if(n!==undefined&&diagram!==undefined&&this.comparison===undefined){openDiscussion(this.media,this.tracker,{node:n,diagram,item:this.atlas.place.item},this.reviewer);} },
        source:async () => { await this.openSelected(); },
      });
    }
  }
  private clarify(id: unknown): void {
    if (this.comparison !== undefined) {
      return;
    }
    const node = this.tracker.snapshot?.nodes.find((n) => n.id === id);
    if (node !== undefined) {
      openDiscussion(this.media, this.tracker, node, this.reviewer);
    }
  }
  private render(): void {
    const current = this.comparison?.target ?? this.tracker.snapshot;
    const base = this.comparison?.base;
    const skipped = (current?.skipped ?? 0) + (base?.skipped ?? 0);
    const message = viewMessage(current, skipped, this.tracker.message);
    void this.panel.webview.postMessage({ action: 'graph', title: viewTitle(current, this.comparison, this.tracker.folder.name), message,
      diff: base !== undefined, graph: current === undefined ? { nodes: [], edges: [] } : compareGraphs(current, base) });
    sendView(this.atlas,this.panel.webview);
  }
  private async openSelected(): Promise<void> {
    const n=selectedSource(this.atlas), snapshot=this.atlas.snapshot;
    if(n===undefined||snapshot===undefined){return;}
    if(this.atlas.side==='base'||this.atlas.target!==undefined){await this.openRevision(snapshot,n.id,n.line);}
    else {await this.openWorking(n);}
  }
  private async compare(): Promise<void> {
    const repo = this.tracker.repository;
    if (repo?.getRefs === undefined) {
      void vscode.window.showInformationMessage('Open a Git repository to compare branch maps.');
      return;
    }
    const request = ++this.sequence;
    const current = (): boolean => request === this.sequence && !this.closed;
    const refs = await repo.getRefs({ pattern: 'refs/heads/' });
    const choices: Choice[] = refs.flatMap((ref) => ref.commit === undefined || ref.name === undefined ? [] : [{
      label: ref.name, description: ref.commit.slice(0, 8), head: { branch: ref.name, commit: ref.commit },
    }]);
    const base = await vscode.window.showQuickPick(choices, { title: 'Architecture comparison · base branch' });
    if (base?.head === undefined || !current()) {
      return;
    }
    const working: Choice = { label: 'Current working tree', description: 'Includes saved local edits' };
    const target = await vscode.window.showQuickPick([working, ...choices], { title: `Compare ${base.label} to…` });
    if (target === undefined || !current()) {
      return;
    }
    const baseHead = base.head;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'MALT: Mapping branch revisions', cancellable: true }, async (progress, token) => {
      progress.report({ message: baseHead.branch });
      const live = (): boolean => current() && !token.isCancellationRequested;
      const from = await revision(this.tracker, repo, baseHead, live);
      if (live()) {
        const to = target.head === undefined ? undefined : await revision(this.tracker, repo, target.head, live);
        if (live()) {
          this.atlas.compare(from,to);
          this.comparison = to === undefined ? { base: from } : { base: from, target: to };
          this.render();
        }
      }
    });
  }
  private async openSource(id: string): Promise<void> {
    const target = this.comparison?.target ?? this.tracker.snapshot;
    const after = target?.nodes.find((node) => node.id === id);
    if (after !== undefined && this.comparison?.target === undefined) {
      await this.openWorking(after);
      return;
    }
    const snapshot = after === undefined ? this.comparison?.base : target;
    if (snapshot !== undefined) {
      await this.openRevision(snapshot, id);
    }
  }
  private async openWorking(node: MapNode): Promise<void> {
    if (node.line < 1 || !eligible(node.path)) {
      return;
    }
    const uri = await workspaceFile(this.tracker.folder, node.path);
    if (uri !== undefined) {
      await present(await vscode.workspace.openTextDocument(uri), node);
    }
  }
  private async openRevision(snapshot: Snapshot, id: string, line?: number): Promise<void> {
    const node = snapshot.nodes.find((n) => n.id === id);
    if (node === undefined || node.line < 1) {
      return;
    }
    const repo = this.tracker.repository;
    const source = repo === undefined ? undefined : await revisionReader(repo, snapshot.commit, this.tracker.folder.uri)(node.path);
    if (source !== undefined) {
      await present(await vscode.workspace.openTextDocument({ content: source }), { ...node,line:line??node.line });
    }
  }
}

export const registerArchitecture = (extension: vscode.Uri, map: { readonly git: GitApi | undefined; readonly noteKey: Buffer }, onFocus: () => void, reviewer: ReviewerAccess): vscode.Disposable => {
  const { git, noteKey } = map;
  const trackers = new Map<string, MapTracker>();
  const panels = new Map<string, MapPanel>();
  const atlases = new Map<string, Atlas>();
  const tree = new AtlasTree(atlases);
  const open = (a: Atlas): void => {
    const key=a.tracker.folder.uri.toString(), existing=panels.get(key);
    if(existing?.visible===true){existing.reveal();}else{panels.set(key,new MapPanel(a,tree,vscode.Uri.joinPath(extension,'media'),reviewer));}
  };
  const sync = (): void => {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file' && vscode.workspace.isTrusted);
    for (const [key, tracker] of trackers) {
      if (!folders.some((f) => f.uri.toString() === key)) {
        atlases.get(key)?.dispose(); atlases.delete(key);
        tracker.dispose();
        panels.get(key)?.dispose();
        trackers.delete(key);
        panels.delete(key);
      }
    }
    for (const folder of folders) {
      if (!trackers.has(folder.uri.toString())) {
        const key=folder.uri.toString(),tracker=new MapTracker(folder,git,noteKey),a=new Atlas(tracker);
        trackers.set(key,tracker); atlases.set(key,a); a.onChange(()=>{tree.refresh();});
      }
    }
    tree.refresh();
  };
  sync();
  const command = vscode.commands.registerCommand('malt.showArchitecture', async () => {
    onFocus();
    const options = [...trackers.values()];
    if (options.length === 0) {
      void vscode.window.showInformationMessage('Open a trusted local workspace folder to explore its architecture.');
      return;
    }
    const tracker = options.length === 1 ? options[0] : (await vscode.window.showQuickPick(options.map((t) => ({ label: t.folder.name, description: t.folder.uri.fsPath, tracker: t })), { title: 'Workspace folder to explore' }))?.tracker;
    if (tracker !== undefined) {
      const a=atlases.get(tracker.folder.uri.toString()); if(a!==undefined){open(a);}
    }
  });
  const agentConnection=agentConnections(extension,noteKey);
  const jump=vscode.commands.registerCommand('malt.openArchitectureView',(key:unknown,input:unknown)=>{
    const a=typeof key==='string'?atlases.get(key):undefined,place=parsePlace(input);
    if(a!==undefined&&place!==undefined){onFocus();a.visit(place);open(a);}
  });
  return vscode.Disposable.from(command,jump,tree,agentConnection,vscode.commands.registerCommand('malt.finalizeDiagram',finalizeFile), vscode.workspace.onDidChangeWorkspaceFolders(sync), vscode.workspace.onDidGrantWorkspaceTrust(sync), new vscode.Disposable(() => {
    vscode.Disposable.from(...panels.values(), ...atlases.values(), ...trackers.values()).dispose();
  }));
};
