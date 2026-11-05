import { isRecord } from '../shared/guards';
import { newDiagram, parseDiagram } from '../shared/diagram';
import type { Diagram, Part } from '../shared/diagram';
import { sqlDiagrams } from './sqlDiagram';

export const workflowPath = (p: string): boolean => /^\.github\/workflows\/[\w.-]+\.ya?ml$/iu.test(p);
export const evidencePath = (p: string): boolean => workflowPath(p) || /\.(?:sql|mmd|mermaid|malt-model\.json|trace\.json)$/iu.test(p);

const unquote = (s: string): string => s.trim().replace(/^['"]|['"]$/gu, '');
interface Job {
  id: string;
  name: string;
  needs: string[];
  steps: Part[];
  line: number;
}
const stepLabel = (s: string | undefined): string => {
  const label = unquote(s ?? '');
  return label === '' ? 'Step' : label;
};
const jobLine = (job: Job, line: string, previous: string, i: number): string => {
  let section = previous;
  const key = /^ {4}([\w-]+):\s*(.*)/u.exec(line);
  if (key !== null) {
    section = key[1] ?? '';
    const value = unquote(key[2] ?? '');
    if (section === 'name') {
      job.name = value;
    }
    if (section === 'needs') {
      job.needs = value.replace(/[[\]]/gu, '').split(',').map(unquote).filter(Boolean);
    }

    return section;
  }
  addStep(job, line, section, i);
  return section;
};
const addStep = (job: Job, line: string, section: string, i: number): void => {
  if (section === 'steps') {
    const step = /^ {4,6}-\s+(?:name|uses|run|id):\s*(.*)/u.exec(line);
    if (step !== null) {
      job.steps.push({ id: `${job.id}/${String(job.steps.length + 1)}`, label: stepLabel(step[1]), group: job.id, line: i + 1 });
    }
  } else if (section === 'needs') {
    const dep = /^\s+-\s+([\w-]+)/u.exec(line)?.[1];
    if (dep !== undefined) {
      job.needs.push(dep);
    }
  }
};
const jobSteps = (lines: string[], index: number): Job => {
  const job: Job = { id: (lines[index] ?? '').trim().replace(/:$/u, ''), name: '', needs: [], steps: [], line: index + 1 };
  let section = '';
  for (let i = index + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }
    if (/^\S|^ {1,2}\S/u.test(line)) {
      break;
    }
    section = jobLine(job, line, section, i);
  }
  return job;
};
const addJobs = (d: Diagram, jobs: Job[]): void => {
  for (const job of jobs) {
    d.items.push({ id: job.id, label: job.name === '' ? job.id : job.name, group: job.id, line: job.line }, ...job.steps);
    let previous = job.id;
    for (const step of job.steps) {
      d.links.push({ from: previous, to: step.id, label: 'next' });
      previous = step.id;
    }
    for (const dep of job.needs) {
      const prior = jobs.find((j) => j.id === dep);
      if (prior !== undefined) {
        d.links.push({ from: prior.steps.at(-1)?.id ?? prior.id, to: job.id, label: 'needs' });
      }
    }
  }
};
const workflow = (path: string, source: string): Diagram[] => {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((s) => /^jobs:\s*(?:#.*)?$/u.test(s));
  if (start < 0) {
    return [];
  }
  const d = newDiagram(path, 'workflow', path);
  const jobs: Job[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const s = lines[i] ?? '';
    if (/^[^ #]/u.test(s)) {
      break;
    }
    if (/^ {2}[\w-]+:\s*$/u.test(s)) {
      jobs.push(jobSteps(lines, i));
    }
  }
  addJobs(d, jobs);
  return d.items.length > 0 ? [d] : [];
};
const stateId = (s: string | undefined, kind: string): string => (s === '[*]' ? `[${kind}]` : (s ?? ''));
const lifecycle = (path: string, source: string): Diagram[] => {
  if (!/^\s*stateDiagram(?:-v2)?\s*$/mu.test(source)) {
    return [];
  }
  const d = newDiagram(path, 'lifecycle', path);
  const labels = new Map<string, string>();
  const lines = source.split(/\r?\n/u);
  for (const line of lines) {
    const alias = /^\s*state\s+"([^"]+)"\s+as\s+([\w.-]+)/u.exec(line);
    if (alias?.[2] !== undefined) {
      labels.set(alias[2], alias[1] ?? alias[2]);
    }
  }
  lines.forEach((line, i) => {
    const m = /^\s*(\[\*\]|[\w.-]+)\s*-->\s*(\[\*\]|[\w.-]+)(?:\s*:\s*(.*))?/u.exec(line);
    if (m === null) {
      return;
    }
    const from = stateId(m[1], 'start');
    const to = stateId(m[2], 'end');
    for (const id of [from, to]) {
      if (!d.items.some((p) => p.id === id)) {
        d.items.push({ id, label: labels.get(id) ?? id, line: i + 1 });
      }
    }
    d.links.push({ from, to, label: m[3]?.trim() ?? '', kind: from === to ? 'retry' : 'transition' });
  });
  return d.items.length > 0 ? [d] : [];
};
const span = (e: unknown, index: number): Part[] => {
  if (!isRecord(e) || e['ph'] !== 'X' || typeof e['name'] !== 'string') {
    return [];
  }
  const start = e['ts'],
    dur = e['dur'];
  if (typeof start !== 'number' || typeof dur !== 'number' || dur < 0 || !Number.isFinite(start + dur)) {
    return [];
  }
  const field = (v: unknown): string => (typeof v === 'number' || typeof v === 'string' ? String(v) : '?');
  return [
    {
      id: String(index),
      label: e['name'],
      start: start / 1000,
      end: (start + dur) / 1000,
      group: `${field(e['pid'])}/${field(e['tid'])}`,
    },
  ];
};
const startOf = (p: Part): number => p.start ?? 0;
const endOf = (p: Part | undefined): number => p?.end ?? 0;
const nestSpans = (items: Part[]): void => {
  const lanes = new Map<string, Part[]>();
  for (const item of items) {
    const lane = item.group ?? '';
    const stack = lanes.get(lane) ?? [];
    while (stack.length > 0 && endOf(stack.at(-1)) < endOf(item)) {
      stack.pop();
    }
    const parent = stack.at(-1);
    if (parent !== undefined && endOf(parent) > startOf(item)) {
      item.parent = parent.id;
    }
    stack.push(item);
    lanes.set(lane, stack);
  }
};
const spanOrder = (a: Part, b: Part): number => {
  const diff = (a.start ?? 0) - (b.start ?? 0);
  return diff !== 0 ? diff : (b.end ?? 0) - (a.end ?? 0);
};
const trace = (path: string, value: unknown): Diagram[] => {
  const events: unknown = isRecord(value) ? value['traceEvents'] : value;
  if (!Array.isArray(events)) {
    return [];
  }
  const d = newDiagram(path, 'waterfall', path);
  const entries: readonly unknown[] = events;
  d.items = entries.flatMap(span).sort(spanOrder);
  nestSpans(d.items);
  return d.items.length > 0 ? [d] : [];
};
export const evidenceDiagrams = (path: string, text: string): Diagram[] => {
  if (workflowPath(path)) {
    return workflow(path, text);
  }
  if (/\.sql$/iu.test(path)) {
    return sqlDiagrams(path, text);
  }
  if (/\.(?:mmd|mermaid)$/iu.test(path)) {
    return lifecycle(path, text);
  }
  try {
    const v: unknown = JSON.parse(text);
    if (path.endsWith('.trace.json')) {
      return trace(path, v);
    }
    if (!isRecord(v) || v['version'] !== 1 || !Array.isArray(v['diagrams'])) {
      return [];
    }
    const entries: readonly unknown[] = v['diagrams'];
    return entries.flatMap((raw) => parseDiagram(raw, path) ?? []);
  } catch {
    return [];
  }
};
