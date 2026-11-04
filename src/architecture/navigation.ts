import * as vscode from 'vscode';
import { catalog, home, location, related } from './catalog';
import type { Place } from './catalog';
import { diagramKey, newDiagram, views } from './diagram';
import type { Diagram, Part, ViewKind } from './diagram';
import type { Snapshot } from './graph';
import type { MapTracker } from './tracker';

export class Atlas implements vscode.Disposable {
  public readonly tracker: MapTracker;
  public models: Diagram[] = [];
  public place: Place = home;
  public base: Snapshot | undefined;
  public target: Snapshot | undefined;
  public side: 'base' | 'target' = 'target';
  private last: Snapshot | undefined;
  private logHead = '';
  private history: Diagram | undefined;
  private readonly back: Place[] = [];
  private readonly changed = new vscode.EventEmitter<void>();
  public readonly onChange = this.changed.event;
  private readonly sub: vscode.Disposable;
  public constructor(tracker: MapTracker) {
    this.tracker = tracker;
    this.sub = tracker.onDidChange(() => { this.update(); });
    this.update();
  }
  public get snapshot(): Snapshot | undefined { return this.side === 'base' ? this.base : this.target ?? this.tracker.snapshot; }
  public get model(): Diagram | undefined { return this.models.find((d) => diagramKey(d) === this.place.key); }
  public get item(): Part | undefined { return this.model?.items.find((i) => i.id === this.place.item); }
  private update(): void {
    const snapshot = this.snapshot;
    if (snapshot === this.last) { return; }
    this.last = snapshot;
    if (snapshot?.commit !== this.logHead) { this.history = undefined; this.logHead = snapshot?.commit ?? ''; void this.loadLog(this.logHead); }
    this.rebuild();
  }
  private async loadLog(commit: string): Promise<void> {
    const log = this.tracker.repository;
    if (commit === '' || log?.log === undefined) { return; }
    try {
      const entries = await log.log({ range: commit, maxEntries: 120 });
      if (this.logHead !== commit) { return; }
      const d = newDiagram('','timeline','Git commit history','git');
      for (const entry of entries) {
        const start = entry.commitDate?.getTime();
        if (start !== undefined) {
          d.items.push({ id:entry.hash, label:entry.message.split('\n')[0] ?? entry.hash, start, detail:entry.hash, group:'Git commits' });
        }
      }
      this.history = d; this.rebuild();
    } catch { /* The repository can be shallow or detached while VS Code is refreshing. */ }
  }
  private rebuild(): void {
    this.models = this.last === undefined ? [] : catalog(this.last,this.history);
    this.place = this.resolve(this.place); this.changed.fire();
  }
  private resolve(p: Place): Place {
    const d = this.models.find((m) => m.kind === p.kind && diagramKey(m) === p.key) ?? this.models.find((m) => m.kind === p.kind);
    return d === undefined ? { kind:p.kind,key:'',item:'' } : location(d,d.items.some((i) => i.id === p.item) ? p.item : '');
  }
  public visit(p: Place): void {
    const next = this.resolve(p);
    if (JSON.stringify(next) !== JSON.stringify(this.place)) {
      this.back.push(this.place); if (this.back.length > 80) { this.back.shift(); }
      this.place = next; this.changed.fire();
    }
  }
  public previous(): void {
    const p = this.back.pop(); if (p !== undefined) { this.place = this.resolve(p); this.changed.fire(); }
  }
  public compare(base?: Snapshot, target?: Snapshot): void {
    this.base = base; this.target = target; this.side = 'target'; this.update(); this.changed.fire();
  }
  public switchSide(): void {
    if (this.base !== undefined) { this.side = this.side === 'base' ? 'target' : 'base'; this.update(); }
  }
  public links(): { label: string; place: Place }[] {
    const d = this.model, item = this.item;
    return d === undefined || item === undefined ? [] : related(this.models,d,item).map((r) => ({
      label: `${(views[r.model.kind][0] ?? r.model.kind)  } · ${  r.model.title}`, place: location(r.model,r.item.id),
    }));
  }
  public menu(kind: ViewKind): { key: string; title: string }[] {
    return this.models.filter((d) => d.kind === kind).map((d) => ({ key:diagramKey(d), title:d.title }));
  }
  public dispose(): void { this.sub.dispose(); this.changed.dispose(); this.logHead = ''; }
}
