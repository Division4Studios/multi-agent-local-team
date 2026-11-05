import type * as vscode from 'vscode';
import type { Atlas } from './navigation';
import type { ReviewerAccess, Turn } from './discussion';
import { dialogueOf } from './discussion';
import { workingReader, revisionReader, eligible } from './sources';
import { digest } from './extract';
import type { Diagram, Part } from '../shared/diagram';
import type { Interpretation } from '../shared/understanding';

export const questionKey = (atlas: Atlas): string => JSON.stringify([atlas.snapshot?.generatedAt, atlas.snapshot?.branch, atlas.snapshot?.commit, atlas.side, atlas.place]);
interface QuestionEvidence { source: string; read: string[]; omitted: number }

const focusedParts = (diagram: Diagram, selected: Part | undefined): Part[] => {
  const peers = new Set(diagram.links.filter((wire) => wire.from === selected?.id || wire.to === selected?.id).flatMap((wire) => [wire.from, wire.to]));
  return [...new Set([...(selected === undefined ? [] : [selected]), ...diagram.items.filter((part) => peers.has(part.id)), ...diagram.items])];
};
export const panelSourcePaths = (atlas: Pick<Atlas, 'model' | 'item' | 'snapshot'>): string[] => {
  const snapshot = atlas.snapshot, diagram = atlas.model, selected = atlas.item;
  if (snapshot === undefined || diagram === undefined) { return []; }
  const parts = focusedParts(diagram, selected);
  return [...new Set([...parts.flatMap((part) => {
    const node = snapshot.nodes.find((candidate) => candidate.id === part.ref || candidate.kind === 'file' && candidate.path === part.detail);
    return node === undefined ? [] : [node.path];
  }), diagram.path])].filter((path) => eligible(path) && snapshot.nodes.some((node) => node.kind === 'file' && node.path === path));
};
const questionReader = (atlas: Atlas): ((path: string) => Promise<string | undefined>) => {
  const repo = atlas.tracker.repository, snapshot = atlas.snapshot;
  const historic = atlas.base !== undefined && (atlas.side === 'base' || atlas.target !== undefined);
  return historic && repo !== undefined && snapshot !== undefined ? revisionReader(repo, snapshot.commit, atlas.tracker.folder.uri) : workingReader(atlas.tracker.folder);
};
const questionSources = async (atlas: Atlas): Promise<QuestionEvidence> => {
  const paths = panelSourcePaths(atlas), read = questionReader(atlas), snapshot = atlas.snapshot;
  let source = '';
  const included: string[] = [];
  for (const path of paths.slice(0, 6)) {
    const content = await read(path);
    const expected = snapshot?.nodes.find((node) => node.kind === 'file' && node.path === path)?.hash;
    if (content === undefined || digest(content.replaceAll('\r\n', '\n')) !== expected) { continue; }
    const block = `\nFile: ${JSON.stringify(path)}\n${content}\n`;
    if (source.length + block.length <= 48_000) { source += block; included.push(path); }
  }
  return { source, read: included, omitted: paths.length - included.length };
};

/** Drop whole context records to preserve valid JSON within the discussion transport budget. */
export const panelQuestionContext = (atlas: Pick<Atlas, 'model' | 'item' | 'snapshot'>, evidence: QuestionEvidence): string => {
  const diagram = atlas.model, selected = atlas.item;
  if (diagram === undefined) { return JSON.stringify({ message: 'No diagram is available.', filesRead: evidence.read }); }
  const parts = focusedParts(diagram, selected).slice(0, 30);
  const ids = new Map(parts.map((part, index) => [part.id, `item${String(index)}`]));
  const focused = diagram.links.filter((wire) => wire.from === selected?.id || wire.to === selected?.id);
  const links = [...new Set([...focused, ...diagram.links])].filter((wire) => ids.has(wire.from) && ids.has(wire.to));
  const context = {
    panel: diagram.title.slice(0, 200), kind: diagram.kind, branch: atlas.snapshot?.branch.slice(0, 200), selected: selected?.label.slice(0, 200),
    items: parts.map((part) => ({ id: ids.get(part.id), label: part.label.slice(0, 120), summary: part.summary?.slice(0, 200), role: part.group?.slice(0, 100) })),
    links: links.slice(0, 30).map((wire) => ({ from: ids.get(wire.from), to: ids.get(wire.to), message: wire.label.slice(0, 150) })),
    coverage: { filesRead: evidence.read.slice(0, 6).map((path) => path.slice(0, 300)), filesOmitted: evidence.omitted, itemsTotal: diagram.items.length, linksTotal: diagram.links.length },
  };
  let text = JSON.stringify(context);
  while (text.length > 12_000 && (context.items.length > 1 || context.links.length > 0)) {
    if (context.items.length > 1) {
      const removed = context.items.pop();
      context.links = context.links.filter((wire) => wire.from !== removed?.id && wire.to !== removed?.id);
    } else { context.links.pop(); }
    text = JSON.stringify(context);
  }
  return text;
};
const validQuestion = (message: Record<string, unknown>, key: string): string | undefined => {
  const text = message['text'];
  return typeof text === 'string' && text.trim() !== '' && text.length <= 1600 && message['key'] === key ? text : undefined;
};
const answerQuestion = async (atlas: Atlas, reviewer: ReviewerAccess, turns: Turn[], key: string): Promise<{ answer: Interpretation; evidence: QuestionEvidence }> => {
  const evidence = await questionSources(atlas);
  if (questionKey(atlas) !== key) { throw new Error('The view changed. Ask again from the current view.'); }
  const client = await reviewer();
  if (client === undefined) { throw new Error('Start the reviewer to ask questions. The map explanations remain available.'); }
  const answer = await client.discuss({ path: atlas.model?.path ?? '', source: evidence.source, context: panelQuestionContext(atlas, evidence), dialogue: dialogueOf(turns) });
  return { answer, evidence };
};
const questionReferences = (atlas: Atlas, paths: readonly string[]): { path: string; id: string }[] =>
  paths.flatMap((path) => {
    const node = atlas.snapshot?.nodes.find((item) => item.kind === 'file' && item.path === path);
    return node === undefined ? [] : [{ path, id: node.id }];
  });

/** Every question is tied to the displayed revision and selection; answers never become saved intent. */
export class PanelQuestions {
  private busy = false;
  private readonly history = new Map<string, Turn[]>();
  private remember(key: string, turns: Turn[], answer: Interpretation): void {
    this.history.set(key, [...turns, { role: 'reviewer', interpretation: answer } satisfies Turn].slice(-12));
    const oldest = this.history.keys().next().value;
    if (this.history.size > 8 && oldest !== undefined) { this.history.delete(oldest); }
  }
  public async ask(atlas: Atlas, web: vscode.Webview, reviewer: ReviewerAccess, message: Record<string, unknown>): Promise<void> {
    const key = questionKey(atlas), text = validQuestion(message, key);
    if (text === undefined) { return; }
    const post = (value: Record<string, unknown>): void => { void web.postMessage({ action: 'viewAnswer', key, ...value }); };
    if (this.busy) { post({ phase: 'error', text: 'The previous question is still being answered. Try again when it finishes.' }); return; }
    this.busy = true;
    post({ phase: 'busy' });
    try {
      const audience = message['audience'] === 'technical' ? 'a developer who wants implementation detail' : 'a product or business colleague with no assumed coding knowledge';
      const turns: Turn[] = [...(this.history.get(key) ?? []), { role: 'developer', text: `Explain for ${audience}. ${text}` }];
      const { answer, evidence } = await answerQuestion(atlas, reviewer, turns, key);
      if (questionKey(atlas) !== key) { return; }
      this.remember(key, turns, answer);
      post({ phase: 'answer', answer, sources: questionReferences(atlas, evidence.read), coverage: `Read ${String(evidence.read.length)} complete source files; ${String(evidence.omitted)} relevant files omitted. Diagram metadata may be inferred.` });
    } catch (error: unknown) { post({ phase: 'error', text: error instanceof Error ? error.message : 'Could not answer this question.' }); }
    finally { this.busy = false; }
  }
}
