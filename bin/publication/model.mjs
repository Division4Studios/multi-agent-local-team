const kinds = new Set([
  'architecture',
  'workflow',
  'sequence',
  'dataflow',
  'lifecycle',
  'er',
  'classes',
  'tree',
  'timeline',
  'waterfall',
]);
const ends = new Set(['1', '0..1', '0..*', '1..*']);
const string = (v) => typeof v === 'string' && v.trim().length > 0;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}
function repository(repo) {
  if (repo !== undefined)
    requireValue(
      object(repo) &&
        /^https:\/\/(?:github|gitlab)\.com\/[\w.-]+(?:\/[\w.-]+)+$/u.test(repo.url) &&
        !repo.url.split('/').some((p) => p === '.' || p === '..') &&
        /^[a-f0-9]{40}$/u.test(repo.revision),
      'Repository sources must be pinned to a full commit',
    );
}
function sourceCard(source) {
  if (source === undefined) return;
  requireValue(
    object(source) &&
      string(source.path) &&
      !/[:\\?#]/u.test(source.path) &&
      [...source.path].every((c) => c.charCodeAt(0) >= 32) &&
      source.path.split('/').every((p) => string(p) && p !== '.' && p !== '..'),
    'Source must be a repository-relative path',
  );
  repository(source.repository);
  if (source.line !== undefined) requireValue(Number.isSafeInteger(source.line) && source.line >= 0, 'Invalid source line');
  if (source.quote !== undefined) requireValue(typeof source.quote === 'string', 'Invalid source quote');
}
function clock(v) {
  if (Number.isFinite(v)) return v;
  if (typeof v === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/iu.test(v)) return Date.parse(v);
  return NaN;
}
function hierarchy(diagram, ids) {
  for (const p of diagram.items) {
    const visited = new Set([p.id]);
    let parent = p.parent;
    while (parent !== undefined) {
      requireValue(ids.has(parent) && !visited.has(parent), 'Unknown or cyclic parent for ' + p.id);
      visited.add(parent);
      const part = ids.get(parent);
      if (diagram.kind === 'waterfall')
        requireValue(part.start <= p.start && part.end >= p.end, 'Span is outside its parent: ' + p.id);
      parent = part.parent;
    }
  }
  if (diagram.kind === 'tree')
    requireValue(diagram.items.filter((p) => p.parent === undefined).length === 1, 'Tree needs exactly one root');
}
function validateDiagram(d) {
  requireValue(object(d) && kinds.has(d.kind) && string(d.id) && string(d.title), 'Unknown view or missing diagram ID/title');
  requireValue(
    Array.isArray(d.items) && d.items.length > 0 && Array.isArray(d.links),
    'A diagram needs items and a relationship list',
  );
  const ids = new Map();
  for (const p of d.items) {
    requireValue(object(p) && string(p.id) && string(p.label) && !ids.has(p.id), 'Missing or duplicate item ID or blank label');
    ids.set(p.id, p);
    for (const key of ['detail', 'group', 'ref', 'parent'])
      if (p[key] !== undefined) requireValue(typeof p[key] === 'string', 'Invalid ' + key);
    if (p.fields !== undefined) requireValue(Array.isArray(p.fields) && p.fields.every(string), 'Blank or invalid column/member');
    sourceCard(p.source);
    if (['timeline', 'waterfall'].includes(d.kind)) {
      p.start = clock(p.start);
      requireValue(Number.isFinite(p.start), 'Missing or invalid start: ' + p.id);
      if (d.kind === 'timeline') requireValue(Math.abs(p.start) <= 8.64e15, 'Date is out of range');
      if (d.kind === 'waterfall') {
        p.end = clock(p.end);
        requireValue(Number.isFinite(p.end) && p.start <= p.end, 'Missing or reversed span: ' + p.id);
      }
    }
  }
  hierarchy(d, ids);
  const wireIds = new Set();
  for (const link of d.links) {
    requireValue(
      object(link) && ids.has(link.from) && ids.has(link.to) && typeof link.label === 'string',
      'Unresolved relationship or missing label',
    );
    if (link.id !== undefined) {
      requireValue(string(link.id) && !wireIds.has(link.id), 'Duplicate or invalid relationship ID');
      wireIds.add(link.id);
    }
    if (link.kind !== undefined) requireValue(typeof link.kind === 'string', 'Invalid relationship kind');
    if (d.kind === 'er') requireValue(ends.has(link.fromEnd) && ends.has(link.toEnd), 'Missing ER endpoint cardinality');
  }
}
export function validateModel(input) {
  const model = globalThis.structuredClone(input);
  requireValue(object(model) && model.version === 1, 'Expected a MALT version 1 model');
  requireValue((model.answer === undefined) !== (model.diagrams === undefined), 'Choose diagrams or one answer');
  if (model.meta !== undefined) requireValue(object(model.meta), 'Invalid model metadata');
  const repo = model.meta?.repository;
  repository(repo);
  if (model.answer !== undefined) {
    const a = model.answer;
    requireValue(object(a) && string(a.title) && Array.isArray(a.panels) && a.panels.length > 0, 'Answer needs a title and panels');
    const ids = new Set();
    for (const p of a.panels) {
      requireValue(object(p) && string(p.id) && !ids.has(p.id) && string(p.title) && string(p.body), 'Invalid answer panel');
      ids.add(p.id);
      sourceCard(p.source);
    }
  } else {
    requireValue(Array.isArray(model.diagrams) && model.diagrams.length > 0, 'No diagrams supplied');
    const ids = new Set();
    for (const d of model.diagrams) {
      validateDiagram(d);
      const k = JSON.stringify([d.kind, d.id, d.path ?? '']);
      requireValue(!ids.has(k), 'Duplicate diagram identity');
      ids.add(k);
    }
  }
  return model;
}
