import { isRecord, parseArray } from '../shared/guards';

export const views = {
  architecture: ['Architecture', 'What is it made of?'],
  workflow: ['Workflow', 'What happens next?'],
  sequence: ['Sequence', 'Who says what, in what order?'],
  dataflow: ['Data flow', 'Where does it all go?'],
  lifecycle: ['Lifecycle', 'Where does it stand now?'],
  er: ['Entity–relationship', 'How does the data relate?'],
  classes: ['Class / interface', 'Which types fulfil which contracts?'],
  tree: ['Tree', 'How is it organised?'],
  timeline: ['Timeline', 'What happened, and when?'],
  waterfall: ['Waterfall', 'Where did the time go?'],
};
export type ViewKind = keyof typeof views;
export const isView = (v: unknown): v is ViewKind => typeof v === 'string' && Object.hasOwn(views, v);
export interface Part {
  id: string;
  label: string;
  ref?: string;
  parent?: string;
  group?: string;
  detail?: string;
  fields?: string[];
  start?: number;
  end?: number;
  line?: number;
}
export interface Wire {
  from: string;
  to: string;
  label: string;
  kind?: string;
  fromEnd?: string;
  toEnd?: string;
}
export interface Diagram {
  id: string;
  kind: ViewKind;
  title: string;
  path: string;
  items: Part[];
  links: Wire[];
}
export const diagramKey = (d: Diagram): string => JSON.stringify([d.path, d.kind, d.id]);
export const newDiagram = (path: string, kind: ViewKind, title: string, id: string = kind): Diagram => ({
  path,
  kind,
  title,
  id,
  items: [],
  links: [],
});
const short = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 2048;
const time = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/iu.test(v)) {
    return undefined;
  }
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
};
const validLine = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const parsePart = (v: unknown): Part | undefined => {
  if (!isRecord(v) || !short(v['id']) || !short(v['label'])) {
    return undefined;
  }
  const part: Part = { id: v['id'], label: v['label'] };
  for (const k of ['ref', 'parent', 'group', 'detail'] as const) {
    if (short(v[k])) {
      part[k] = v[k];
    }
  }
  if (Array.isArray(v['fields'])) {
    part.fields = v['fields'].filter(short);
  }
  for (const key of ['start', 'end'] as const) {
    const n = time(v[key]);
    if (n !== undefined) {
      part[key] = n;
    }
  }
  const line = v['line'];
  if (validLine(line)) {
    part.line = line;
  }
  return part;
};
const parseWire = (v: unknown): Wire | undefined => {
  if (!isRecord(v) || !short(v['from']) || !short(v['to'])) {
    return undefined;
  }
  const link: Wire = { from: v['from'], to: v['to'], label: short(v['label']) ? v['label'] : '' };
  for (const k of ['kind', 'fromEnd', 'toEnd'] as const) {
    if (short(v[k])) {
      link[k] = v[k];
    }
  }
  return link;
};
const validClock = (kind: ViewKind, item: Part): boolean => {
  if (kind === 'waterfall') {
    return item.start !== undefined && item.end !== undefined && item.end >= item.start;
  }
  if (kind === 'timeline') {
    return item.start !== undefined && Math.abs(item.start) <= 8.64e15;
  }
  return true;
};
const consistent = (items: Part[], kind: ViewKind): boolean =>
  new Set(items.map((i) => i.id)).size === items.length && items.every((i) => validClock(kind, i));
export const parseDiagram = (v: unknown, path?: string): Diagram | undefined => {
  if (!isRecord(v) || !isView(v['kind']) || !short(v['id']) || !short(v['title'])) {
    return undefined;
  }
  const source: unknown = path ?? v['path'];
  if (typeof source !== 'string') {
    return undefined;
  }
  const items = parseArray(v['items'], parsePart);
  const links = parseArray(v['links'], parseWire);
  if (items === undefined || links === undefined) {
    return undefined;
  }
  const kind = v['kind'];
  if (!consistent(items, kind)) {
    return undefined;
  }
  return { path: source, id: v['id'], kind, title: v['title'], items, links };
};
