/* A keyboard-accessible neighbourhood of the graph. The extension owns source navigation and branch selection. */
(function () {
  'use strict';
  const host = window.acquireVsCodeApi();
  window.startMaltTheme?.(host);
  const el = id => document.getElementById(id);
  const svg = el('map');
  const root = 'workspace';
  const pageSize = 7;
  const cardWidth = 304, connectionGap = 92, graphWidth = 3 * cardWidth + 2 * connectionGap + 32;
  const marks = { added: '+', removed: '−', changed: '~', same: '' };
  let nodes = new Map(), children = new Map(), edges = [], focus = root, history = [];
  let page = 0, zoom = 1, comparing = false, traceStart, traceEnd;
  const post = (action, id) => host.postMessage({ action, id });
  const button = (label, action) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', action);
    return b;
  };
  const lenses = window.startMaltViews?.(m => host.postMessage(m), id => visit(id, false));
  const questions = window.startMaltQuestions?.(m => host.postMessage(m));
  function visit(id, sync = true) {
    if (!nodes.has(id)) { return; }
    if (id !== focus) { history.push(focus); }
    focus = id;
    if (sync && lenses) { host.postMessage({action:"graphFocus",id}); }
    page = 0;
    el('search').value = '';
    el('matches').replaceChildren();
    draw();
  }
  function chain(id) {
    const path = [];
    let n = nodes.get(id);
    while (n && path.length < 180 && !path.includes(n)) {
      path.push(n);
      n = nodes.get(n.parent);
    }
    return path;
  }
  function declarationExplanation(n, knowledge) {
    if (n.kind === 'file' || !knowledge) { return undefined; }
    let qualified = n.label;
    try {
      const id = JSON.parse(n.id);
      if (Array.isArray(id) && typeof id[1] === 'string') { qualified = id[1]; }
    } catch { /* Older cached graph identities may not encode a qualified declaration. */ }
    const explanations = knowledge.explanations || [];
    if (qualified !== n.label) {
      const exact = explanations.find(item => item.symbol === qualified);
      if (exact) { return exact; }
    }
    const matches = [...nodes.values()].filter(node => node.path === n.path && node.label === n.label);
    return matches.length === 1 ? explanations.find(item => item.symbol === n.label) : undefined;
  }
  function nodeSummary(n) {
    const knowledge = nodes.get('file:' + n.path)?.understanding;
    if (n.kind === 'file' && knowledge) { return knowledge.confirmed || knowledge.what; }
    const explanation = declarationExplanation(n, knowledge);
    if (explanation?.summary) { return explanation.summary; }
    const owned = children.get(n.id)?.length || 0;
    if (owned) { return 'Groups ' + owned + ' items. Open it to explore what belongs here.'; }
    const outgoing = edges.filter(edge => edge.from === n.id).length;
    const incoming = edges.filter(edge => edge.to === n.id).length;
    if (incoming || outgoing) { return incoming + ' incoming and ' + outgoing + ' outgoing connections. Ask about this item to understand its role.'; }
    return 'Its role has not been explained yet. Ask about this item to inspect the available evidence.';
  }
  function understanding(n) {
    const box = el('knowledge');
    box.replaceChildren();
    const file = nodes.get('file:' + n.path);
    const k = file && file.understanding;
    el('clarify').hidden = comparing || !file;
    if (!k) {
      box.textContent = file ? 'No agent analysis for this file version. Discuss it to analyze the source.' :
        'Select a file or declaration to explore what it does and why.';
      return;
    }
    function line(label, text) {
      const p = document.createElement('p'), heading = document.createElement('strong');
      heading.textContent = label + ' · ';
      p.append(heading, document.createTextNode(text));
      box.append(p);
    }
    line('File', file.path);
    if (n.kind !== 'file') {
      const explanation = declarationExplanation(n, k);
      line(explanation?.evidence ? 'Selected declaration · source excerpt available' : 'Selected declaration', nodeSummary(n));
      if (explanation?.evidence) { line('Declaration evidence', explanation.evidence); }
    }
    if (k.confirmed) { line('Developer clarification for this file', k.confirmed); }
    line(k.whatEvidence ? 'File context · source evidence' : 'File context · working hypothesis', k.what);
    if (k.whatEvidence) { line('Evidence', k.whatEvidence); }
    line(k.whyEvidence ? 'Why · documented rationale' : 'Why · working hypothesis', k.why);
    if (k.whyEvidence) { line('Evidence', k.whyEvidence); }
    if (k.question && !k.confirmed) {
      if (comparing) { line('Open question', k.question); }
      else { box.append(button(k.question + ' · Clarify…', () => post('clarify', focus))); }
    }
  }
  function crumbs(n) {
    const nav = el('crumbs');
    nav.replaceChildren();
    chain(n.id).reverse().forEach(item => nav.append(button(item.label, () => visit(item.id))));
    el('back').disabled = history.length === 0;
    el('detail').textContent = n.label;
    const details = [n.kind, n.path && (n.path + (n.line ? ' · line ' + n.line : '')), n.tags.join(' / ')];
    if (comparing) { details.push(n.status); }
    el('evidence').textContent = details.filter(Boolean).join('   ·   ');
    el('source').hidden = !n.line;
  }
  function passes(n) {
    const tag = el('tags').value;
    return (!tag || n.tags.includes(tag)) && (!comparing || !el('changed').checked || n.status !== 'same');
  }
  function search() {
    const term = el('search').value.trim().toLowerCase();
    const result = el('matches');
    result.replaceChildren();
    if (!term) { return; }
    const found = [...nodes.values()].filter(n => passes(n) && (n.label + ' ' + n.path).toLowerCase().includes(term));
    for (const n of found.slice(0, 30)) {
      result.append(button(n.label + ' · ' + (n.path || n.kind), () => visit(n.id)));
    }
    const hint = document.createElement('span');
    hint.textContent = found.length > 30 ? 'First 30 of ' + found.length + ' matches. Refine your search.' : found.length + ' matches';
    result.append(hint);
  }
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) { e.setAttribute(key, String(value)); }
    return e;
  };
  function wrapCardText(value) {
    const width = (text) => [...text].reduce((sum, c) => sum + (/[MW@#%]/u.test(c) ? 13 : /[ilI.,:;|'! ]/u.test(c) ? 4 : /[A-Z]/u.test(c) ? 10 : c.codePointAt(0) > 255 ? 14 : 8), 0);
    const lines = [];
    let line = '';
    for (const word of String(value).trim().split(/\s+/u)) {
      if (line && width(line + ' ' + word) > cardWidth - 32) { lines.push(line); line = ''; }
      for (const c of (line ? ' ' : '') + word) {
        if (line && width(line + c) > cardWidth - 32) { lines.push(line); line = ''; }
        line += c;
      }
    }
    if (line) { lines.push(line); }
    return lines;
  }
  function cardLayout(item) {
    const rows = [];
    for (const [value, className] of [[(marks[item.status] + ' ' + item.label).trim(), 'caption'], [item.node.label, 'card-title'], [nodeSummary(item.node), 'card-summary']]) {
      rows.push(...wrapCardText(value).map(text => ({ text, className })));
    }
    return { rows, height: rows.length * 19 + 26 };
  }
  function card(item, x, y, center, layout) {
    const n = item.node;
    const title = [item.label, n.label, n.path, comparing && item.status].filter(Boolean).join(' · ');
    const g = svgEl('g', { transform: 'translate(' + x + ',' + y + ')', role: 'button', tabindex: 0,
      'aria-label': title, 'aria-description': nodeSummary(n), 'aria-pressed': String(center), 'data-item': n.id, 'data-kind': n.kind, class: 'node ' + item.status + (center ? ' active' : '') });
    const tooltip = svgEl('title', {});
    tooltip.textContent = title + '\n' + nodeSummary(n);
    g.append(tooltip, svgEl('rect', { width: cardWidth, height: layout.height, rx: 8 }));
    layout.rows.forEach((row, index) => {
      const label = svgEl('text', { x: 16, y: 24 + index * 19, class: row.className });
      label.textContent = row.text;
      g.append(label);
    });
    const select = () => center && n.line ? post('source', n.id) : visit(n.id);
    g.addEventListener('click', select);
    g.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
    });
    svg.append(g);
  }
  function wire(x, y, toX, toY, status) {
    const mid = (x + toX) / 2;
    const d = 'M' + x + ',' + y + ' C' + mid + ',' + y + ' ' + mid + ',' + toY + ' ' + toX + ',' + toY;
    svg.append(svgEl('path', { d, class: 'wire ' + status, 'marker-end': 'url(#arrow)' }));
  }
  function arrow() {
    const defs = svgEl('defs', {});
    const marker = svgEl('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto' });
    marker.append(svgEl('path', { d: 'M0 0 L10 5 L0 10 z', class: 'arrow' }));
    defs.append(marker);
    svg.append(defs);
  }
  // For a subsystem, fold edges between its descendants and other subsystems into labelled connections.
  function relations(n, incoming, outgoing) {
    const scope = n.kind === 'folder' || n.kind === 'file';
    const ancestry = new Map();
    function lineage(id) {
      if (!ancestry.has(id)) { ancestry.set(id, chain(id)); }
      return ancestry.get(id);
    }
    const inside = id => id === n.id || (scope && lineage(id).some(v => v.id === n.id));
    function peer(id) {
      if (!scope) { return nodes.get(id); }
      return lineage(id).find(v => v.parent === n.parent) || nodes.get(id);
    }
    const groups = new Map();
    for (const e of edges) {
      const lens = el('relation').value;
      if (lens && lens !== e.kind) { continue; }
      const from = inside(e.from), to = inside(e.to);
      if (from === to) { continue; }
      const node = peer(from ? e.to : e.from);
      if (!node) { continue; }
      const key = JSON.stringify([from, node.id, e.kind, e.status]);
      const group = groups.get(key) || { node, kind: e.kind, status: e.status, from, count: 0 };
      group.count++;
      groups.set(key, group);
    }
    for (const g of groups.values()) {
      const item = { node: g.node, status: g.status, label: g.kind + (g.count > 1 ? ' ×' + g.count : '') };
      (g.from ? outgoing : incoming).push(item);
    }
  }
  function neighbours(n) {
    const left = [], right = [];
    const lens = el('relation').value;
    if (!lens || lens === 'structure' || n.id === root) {
      const parent = nodes.get(n.parent);
      if (parent) { left.push({ node: parent, label: 'contains', status: n.status }); }
      for (const child of children.get(n.id) || []) {
        right.push({ node: child, label: child.kind, status: child.status });
      }
    }
    if (lens !== 'structure') { relations(n, left, right); }
    const tag = el('tags').value;
    const matching = tag ? new Set([...nodes.values()].filter(v => v.tags.includes(tag)).flatMap(v => chain(v.id).map(a => a.id))) : undefined;
    const include = item => (!matching || matching.has(item.node.id)) &&
      (!comparing || !el('changed').checked || item.status !== 'same' || item.node.status !== 'same');
    return [left.filter(include), right.filter(include)];
  }
  // Search one side of the comparison so a path cannot mix removed edges with added ones.
  function shortestPath(start, end) {
    const exclude = el('traceSide').value === 'base' ? 'added' : 'removed';
    const outgoing = new Map();
    for (const edge of edges) {
      if (comparing && edge.status === exclude) { continue; }
      const group = outgoing.get(edge.from) || [];
      group.push(edge);
      outgoing.set(edge.from, group);
    }
    const previous = new Map([[start, null]]), queue = [start];
    for (let i = 0; i < queue.length && !previous.has(end); i++) {
      for (const edge of outgoing.get(queue[i]) || []) {
        if (!previous.has(edge.to)) { previous.set(edge.to, edge); queue.push(edge.to); }
      }
    }
    if (!previous.has(end)) { return undefined; }
    const path = [];
    for (let edge = previous.get(end); edge; edge = previous.get(edge.from)) { path.push(edge); }
    return path.reverse();
  }
  function trail() {
    const area = el('trail');
    area.replaceChildren();
    el('traceVersion').hidden = !comparing;
    el('traceStart').disabled = !nodes.has(focus);
    el('traceEnd').disabled = !nodes.has(traceStart) || traceStart === focus;
    el('traceClear').hidden = !traceStart;
    if (!nodes.has(traceStart)) { return; }
    area.append(button(nodes.get(traceStart).label, () => visit(traceStart)));
    if (!nodes.has(traceEnd)) { return; }
    const path = shortestPath(traceStart, traceEnd);
    if (!path) {
      area.append(document.createTextNode(' No resolved directed path to ' + nodes.get(traceEnd).label + ' in this snapshot.'));
      return;
    }
    path.forEach(edge => {
      area.append(document.createTextNode(' ' + edge.kind + ' → '), button(nodes.get(edge.to).label, () => visit(edge.to)));
    });
  }
  function draw() {
    const focused = svg.contains?.(document.activeElement) ? document.activeElement?.getAttribute('data-item') : undefined;
    svg.replaceChildren();
    const n = nodes.get(focus);
    if (!n) {
      el('crumbs').replaceChildren();
      el('detail').textContent = 'Waiting for a map';
      el('evidence').textContent = '';
      el('source').hidden = true;
      return;
    }
    crumbs(n);
    understanding(n);
    trail();
    const [left, right] = neighbours(n);
    const pages = Math.max(1, Math.ceil(Math.max(left.length, right.length) / pageSize));
    page = Math.min(page, pages - 1);
    const slice = a => a.slice(page * pageSize, (page + 1) * pageSize);
    const sides = [slice(left), slice(right)].map(items => items.map(item => ({ ...item, layout: cardLayout(item) })));
    const selected = { node: n, label: n.kind + ' · selected', status: n.status };
    const selectedLayout = cardLayout(selected);
    const columnHeight = items => items.reduce((sum, item) => sum + item.layout.height + 32, 0) - 32;
    const height = Math.max(240, selectedLayout.height + 48, ...sides.map(items => columnHeight(items) + 48));
    svg.setAttribute('viewBox', '0 0 ' + graphWidth + ' ' + height);
    svg.setAttribute('width', String(graphWidth * zoom));
    svg.setAttribute('height', String(height * zoom));
    const cy = height / 2;
    const middleX = 16 + cardWidth + connectionGap, rightX = middleX + cardWidth + connectionGap;
    arrow();
    sides.forEach((items, i) => {
      let y = (height - columnHeight(items)) / 2;
      items.forEach(item => {
        const centerY = y + item.layout.height / 2;
        if (i === 0) { wire(16 + cardWidth, centerY, middleX, cy, item.status); }
        else { wire(middleX + cardWidth, cy, rightX, centerY, item.status); }
        card(item, i === 0 ? 16 : rightX, y, false, item.layout);
        y += item.layout.height + 32;
      });
    });
    card(selected, middleX, cy - selectedLayout.height / 2, true, selectedLayout);
    el('pages').textContent = 'Page ' + (page + 1) + ' of ' + pages + ' · ' + left.length + ' incoming / ' + right.length + ' outgoing';
    el('less').disabled = page === 0;
    el('more').disabled = page + 1 >= pages;
    if (focused) { [...svg.querySelectorAll('[data-item]')].find(item => item.getAttribute('data-item') === focused)?.focus({ preventScroll: true }); }
  }
  function receive(event) {
    if (event.origin !== window.origin) { return; }
    const m = event.data;
    if (m?.action === 'perspective') { questions?.(m); lenses?.(m); return; }
    if (m?.action === 'viewAnswer') { questions?.(m); return; }
    if (!m || m.action !== 'graph') { return; }
    comparing = m.diff;
    el('title').textContent = m.title;
    el('mapContext').textContent = m.context || '';
    el('status').textContent = m.message + (m.diff ? '   ·   + added   − removed   ~ changed' : '');
    el('diffFilter').hidden = !m.diff;
    el('live').hidden = !m.diff;
    nodes = new Map(m.graph.nodes.map(n => [n.id, n]));
    edges = m.graph.edges;
    children = new Map();
    const tags = new Set();
    nodes.forEach(n => {
      const siblings = children.get(n.parent) || [];
      siblings.push(n);
      children.set(n.parent, siblings);
      n.tags.forEach(t => tags.add(t));
    });
    children.forEach(list => list.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.label.localeCompare(b.label)));
    const select = el('tags'), previous = select.value;
    select.replaceChildren();
    for (const tag of ['', ...[...tags].sort()]) {
      const option = document.createElement('option');
      option.value = tag;
      option.textContent = tag || 'All tags';
      select.append(option);
    }
    select.value = tags.has(previous) ? previous : '';
    if (!nodes.has(traceStart)) { traceStart = undefined; traceEnd = undefined; }
    if (!nodes.has(focus)) { focus = root; history = []; }
    draw();
    search();
  }
  ['compare', 'live', 'refresh', 'summaries'].forEach(id => el(id).addEventListener('click', () => post(id)));
  el('traceStart').addEventListener('click', () => { traceStart = focus; traceEnd = undefined; trail(); });
  el('traceEnd').addEventListener('click', () => { traceEnd = focus; trail(); });
  el('traceClear').addEventListener('click', () => { traceStart = undefined; traceEnd = undefined; trail(); });
  el('traceSide').addEventListener('change', trail);
  el('source').addEventListener('click', () => post('source', focus));
  // Going back changes the selection too: tell the extension, so export and "copy question" use the visible layer.
  el('back').addEventListener('click', () => {
    focus = history.pop() || root;
    if (lenses) { host.postMessage({ action: 'graphFocus', id: focus }); }
    page = 0;
    draw();
  });
  el('search').addEventListener('input', search);
  ['tags', 'changed', 'relation'].forEach(id => el(id).addEventListener('change', () => { page = 0; draw(); search(); }));
  el('more').addEventListener('click', () => { page++; draw(); });
  el('less').addEventListener('click', () => { page = Math.max(0, page - 1); draw(); });
  el('zoomIn').addEventListener('click', () => { zoom = Math.min(3, zoom * 1.25); draw(); });
  el('zoomOut').addEventListener('click', () => { zoom = Math.max(0.4, zoom / 1.25); draw(); });
  el('fit').addEventListener('click', () => { zoom = Math.max(0.25, Math.min(2, svg.parentElement.clientWidth / graphWidth)); draw(); });
  window.addEventListener('message', receive);
  post('ready');
}());
