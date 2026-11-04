import { requireValue } from './model.mjs';
const signature = (w) => JSON.stringify([w.from, w.to, w.kind ?? '', w.label, w.fromEnd, w.toEnd]);
const pair = (a, b) => a.kind === b.kind && a.label === b.label && (a.from === b.from || a.to === b.to);
function diffLinks(before, after) {
  const used = new Set(),
    matched = new Map();
  function match(i, predicate) {
    const candidates = after.map((wire, n) => ({ wire, n })).filter((v) => !used.has(v.n) && predicate(v.wire));
    if (!candidates.length) return;
    const n = candidates[0].n;
    matched.set(i, n);
    used.add(n);
  }
  before.forEach((w, i) => {
    if (w.id) match(i, (target) => target.id === w.id);
  });
  before.forEach((w, i) => {
    if (!matched.has(i) && !w.id) match(i, (target) => !target.id && signature(w) === signature(target));
  });
  before.forEach((w, i) => {
    if (matched.has(i) || w.id) return;
    const choices = after.filter((v, n) => !used.has(n) && !v.id && pair(w, v));
    if (choices.length === 1 && before.filter((v, n) => !matched.has(n) && !v.id && pair(v, choices[0])).length === 1)
      match(i, (target) => target === choices[0]);
  });
  const links = [],
    changes = [];
  before.forEach((w, i) => {
    if (!matched.has(i)) {
      links.push({ ...w, change: 'removed' });
      changes.push({ type: 'removed', before: w });
      return;
    }
    const v = after[matched.get(i)];
    if (signature(w) === signature(v)) {
      links.push(v);
      return;
    }
    const type = w.from !== v.from || w.to !== v.to ? 'rerouted' : 'changed';
    changes.push({ type, before: w, after: v });
    links.push({ ...w, change: 'removed', label: w.label + ' (before)' }, { ...v, change: type });
  });
  after.forEach((w, i) => {
    if (!used.has(i)) {
      links.push({ ...w, change: 'added' });
      changes.push({ type: 'added', after: w });
    }
  });
  return {
    links: links.map((w) => {
      const copy = { ...w };
      delete copy.id;
      return copy;
    }),
    changes,
  };
}
const pin = (p, meta) => (p.source ? { ...p, source: { ...p.source, repository: meta?.repository } } : p);
export function compareModels(base, head) {
  const a = base.diagrams?.[0],
    b = head.diagrams?.[0];
  requireValue(
    a?.kind === 'architecture' && b?.kind === 'architecture' && base.diagrams.length === 1 && head.diagrams.length === 1,
    'Compare needs two individual architecture views',
  );
  const left = new Map(a.items.map((p) => [p.id, p])),
    right = new Map(b.items.map((p) => [p.id, p])),
    changes = [];
  const items = [...new Set([...right.keys(), ...left.keys()])].map((id) => {
    const old = left.get(id),
      now = right.get(id),
      p = now ?? old;
    const change = !old ? 'added' : !now ? 'removed' : JSON.stringify(old) !== JSON.stringify(now) ? 'changed' : 'same';
    if (change !== 'same') changes.push({ id, change, before: old, after: now });
    return { ...pin(p, now ? head.meta : base.meta), change };
  });
  const diff = diffLinks(a.links, b.links);
  return {
    model: {
      version: 1,
      meta: { locale: head.meta?.locale },
      diagrams: [{ ...b, title: b.title + ' · branch comparison', items, links: diff.links }],
    },
    delta: { version: 1, nodes: changes, relationships: diff.changes },
  };
}
