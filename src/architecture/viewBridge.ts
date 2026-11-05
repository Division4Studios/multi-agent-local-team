import * as vscode from 'vscode';
import { isRecord } from '../shared/guards';
import { isView, views } from '../shared/diagram';
import { finalizeView } from './finalize';
import type { Atlas } from './navigation';
import type { Place } from './catalog';
import type { MapNode } from './graph';
import { narrateView } from './narration';
import { questionKey } from './panelQuestions';

export const parsePlace = (m: unknown): Place | undefined => {
  if (!isRecord(m) || !isView(m['kind']) || typeof m['key'] !== 'string' || typeof m['item'] !== 'string') {
    return undefined;
  }
  return { kind: m['kind'], key: m['key'], item: m['item'] };
};
const hints: Readonly<Record<string, string>> = {
  workflow: 'Add a GitHub Actions workflow or an authored workflow.',
  lifecycle: 'Add a Mermaid state diagram (.mmd) or an authored lifecycle.',
  dataflow: 'Add a SQL INSERT … SELECT statement or an authored data-flow diagram.',
  er: 'Add SQL CREATE TABLE declarations.',
  timeline: 'Open a Git repository or provide timestamped events.',
  waterfall: 'Provide a *.trace.json with Chrome complete-duration events or authored timed spans.',
  classes: 'Select a project with class or interface declarations.',
  sequence: 'Select a project with resolved calls or an authored exchange.',
};
export const selectedSource = (a: Atlas): MapNode | undefined => {
  const s = a.snapshot,
    p = a.item,
    d = a.model;
  if (s === undefined || p === undefined || d === undefined) {
    return undefined;
  }
  const exact = s.nodes.find((n) => n.id === p.ref);
  if (exact !== undefined) {
    return exact;
  }
  const file = s.nodes.find((n) => n.kind === 'file' && (n.path === d.path || n.path === p.detail));
  return file === undefined ? undefined : { ...file, line: p.line ?? file.line };
};
export const sendView = (a: Atlas, web: vscode.Webview): void => {
  const d = a.model,
    p = a.place,
    src = selectedSource(a);
  void web.postMessage({
    action: 'perspective',
    questionKey: questionKey(a),
    kinds: Object.entries(views).map(([k, v]) => [k, v[0]]),
    question: views[p.kind][1],
    place: p,
    menu: a.menu(p.kind),
    model: d,
    narration: d === undefined || a.snapshot === undefined ? undefined : narrateView(d, p.item, a.snapshot),
    related: a.links(),
    source: src !== undefined,
    discuss: a.base === undefined && src !== undefined,
    compare: a.base !== undefined,
    side: a.side,
    empty: hints[p.kind] ?? 'No evidence for this view.',
  });
};
const copyPrompt = async (a: Atlas, passage: unknown): Promise<void> => {
  const info = {
    branch: a.snapshot?.branch,
    commit: a.snapshot?.commit,
    kind: a.place.kind,
    panel: a.model?.title,
    id: a.item?.id,
    source: selectedSource(a)?.path,
    selection: typeof passage === 'string' ? passage.slice(0, 1600) : '',
  };
  await vscode.env.clipboard.writeText(
    `Discuss this MALT panel. Read the workspace guidance first. Propose a revision scoped to the identified panel and cite evidence.\n${JSON.stringify(info, null, 2)}`,
  );
};
const focusItem = (a: Atlas, id: unknown): void => {
  if (typeof id === 'string') {
    a.visit({ ...a.place, item: id });
  }
};
interface Actions {
  source: () => Promise<void>;
  discuss: () => void;
  tray: () => Promise<void>;
}
export const handleView = async (a: Atlas, m: Record<string, unknown>, ops: Actions): Promise<void> => {
  if (m['action'] === 'perspective') {
    const p = parsePlace(m);
    if (p !== undefined) {
      a.visit(p);
    }
    return;
  }
  const actions: ReadonlyMap<string, () => void | Promise<void>> = new Map<string, () => void | Promise<void>>([
    [
      'graphFocus',
      ():void => {
        focusItem(a, m['id']);
      },
    ],
    [
      'viewPrompt',
      async ():Promise<void> => {
        await copyPrompt(a, m['passage']);
      },
    ],
    ['viewTray', ops.tray],
    [
      'viewSide',
      ():void => {
        a.switchSide();
      },
    ],
    [
      'viewBack',
      ():void => {
        a.previous();
      },
    ],
    ['viewSource', ops.source],
    ['viewDiscuss', ops.discuss],
    [
      'viewExport',
      async ():Promise<void> => {
        await finalizeView(a);
      },
    ],
  ]);
  const action = m['action'];
  if (typeof action === 'string') {
    await actions.get(action)?.();
  }
};
