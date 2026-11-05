/* Layout coordinates are shared by live and still display. All repository strings are text nodes. */
globalThis.maltPalette = function (group) {
  let h = 0;
  for (const c of group || 'component') { h = (31 * h + c.charCodeAt(0)) | 0; }
  return 'role' + String(Math.abs(h) % 7);
};
globalThis.drawMaltPerspective = function (svg, d, visible, select, settings) {
  const focused = svg.contains?.(svg.ownerDocument.activeElement) ? svg.ownerDocument.activeElement?.getAttribute('data-item') : undefined;
  const ns = 'http://www.w3.org/2000/svg';
  const element = (type, attrs, text, parent = svg) => {
    const n = svg.ownerDocument.createElementNS(ns, type);
    for (const [k, v] of Object.entries(attrs)) {
      n.setAttribute(k, String(v));
    }
    if (text !== undefined) {
      n.textContent = text;
    }
    parent.append(n);
    return n;
  };
  const line = (x1, y1, x2, y2, cls = 'wire') => element('line', { x1, y1, x2, y2, class: cls });
  const text = (x, y, value, cls = 'caption') => element('text', { x, y, class: cls }, value);
  const palette = globalThis.maltPalette;
  // Conservative text widths keep the same layout in the webview and dependency-free export renderer.
  const letterWidth = (c) => /[MW@#%]/u.test(c) ? 12 : /[ilI.,:;|'! ]/u.test(c) ? 4 : /[A-Z]/u.test(c) ? 9 : c.codePointAt(0) > 255 ? 13 : 8;
  const textWidth = (value) => [...value].reduce((sum, c) => sum + letterWidth(c), 0);
  function wrap(value, maxWidth) {
    const result = [];
    let row = '';
    for (const word of String(value).trim().split(/\s+/u)) {
      if (row && textWidth(row + ' ' + word) > maxWidth) { result.push(row); row = ''; }
      for (const c of (row ? ' ' : '') + word) {
        if (row && textWidth(row + c) > maxWidth) { result.push(row); row = ''; }
        row += c;
      }
    }
    if (row) { result.push(row); }
    return result;
  }
  const members = (part) => {
    const attributes = [], operations = [];
    for (const field of part.fields || []) {
      const before = field.split('(')[0];
      const operation = field.includes('(') && !/[=:]/u.test(before);
      (operation ? operations : attributes).push(field.replace(/;\s*$/u, ''));
    }
    return { attributes, operations };
  };
  function responsibility(part) {
    if (part.summary) { return part.summary; }
    const detail = (part.detail || '').trim();
    const path = !/\s/u.test(detail) && (/[\\/]/u.test(detail) || /\.[a-z\d]{1,8}$/iu.test(detail) || /^[a-f\d]{32,64}$/iu.test(detail));
    if (detail && !path) { return detail; }
    const incoming = d.links.filter((wire) => wire.to === part.id).length;
    const outgoing = d.links.filter((wire) => wire.from === part.id).length;
    if (d.kind === 'sequence') { return `Sends ${outgoing} and receives ${incoming} messages in this exchange.`; }
    if (d.kind === 'classes') {
      const { attributes, operations } = members(part);
      return `${part.group === 'interface' ? 'Defines a contract' : 'Defines a type'} with ${attributes.length} attributes and ${operations.length} operations.`;
    }
    if (d.kind === 'er') { return `Stores records with ${(part.fields || []).length} mapped fields.`; }
    if (d.kind === 'waterfall') { return `Measured duration: ${Math.round((part.end - part.start) * 100) / 100} ms.`; }
    if (d.kind === 'timeline') { return 'Recorded event in the project timeline.'; }
    const owned = d.items.filter((item) => item.parent === part.id).length;
    if (owned) { return `Contains ${owned} items. Select to explore them.`; }
    return incoming || outgoing ? `${incoming} incoming and ${outgoing} outgoing connections.` : 'No connections are recorded for this item.';
  }
  function cardLayout(part, cardWidth, includeMembers = false) {
    const rows = [];
    const add = (value, cls) => wrap(value, cardWidth - 32).forEach((value) => rows.push({ value, cls }));
    if (d.kind === 'classes') { add('«' + (part.group || 'type') + '»', 'card-stereotype'); }
    else if (part.group) { add(part.group, 'card-stereotype'); }
    add(part.label, 'card-title');
    add(responsibility(part), 'card-summary');
    if (d.kind === 'classes') {
      const { attributes, operations } = members(part);
      if (includeMembers) {
        for (const [label, values] of [['Attributes', attributes], ['Operations', operations]]) {
          rows.push({ rule: true }); add(label, 'compartment-heading');
          if (!values.length) { add('None recorded', 'card-summary'); }
          values.forEach((value) => add(value, 'card-member'));
        }
      }
    } else if (includeMembers && part.fields?.length) {
      rows.push({ rule: true }); add('Fields', 'compartment-heading');
      part.fields.forEach((value) => add(value, 'card-member'));
    }
    return { rows, h: 24 + rows.reduce((size, row) => size + (row.rule ? 14 : 18), 0) };
  }
  function hit(part, x, y, width, height, layout) {
    const g = element('g', {
      class: 'model-card ' + palette(part.group) + (settings.selected === part.id ? ' selected' : ''),
      role: 'button',
      tabindex: 0,
      'aria-label': part.label + '. ' + responsibility(part),
      'data-item': part.id,
      'data-change': part.change || '',
      'aria-pressed': settings.selected === part.id ? 'true' : 'false',
    });
    element('title', {}, [part.label, responsibility(part), part.detail, ...(settings.fields ? part.fields || [] : [])].filter(Boolean).join('\n'), g);
    element('rect', { x, y, width, height, rx: 8 }, undefined, g);
    let baseline = y + 24;
    for (const row of layout.rows) {
      if (row.rule) {
        element('line', { x1: x, y1: baseline - 3, x2: x + width, y2: baseline - 3, class: 'compartment-rule' }, undefined, g);
        baseline += 14;
      } else {
        element('text', { x: x + 16, y: baseline, class: row.cls }, row.value, g);
        baseline += 18;
      }
    }
    g.addEventListener('click', () => select(part.id));
    g.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        select(part.id);
      }
    });
  }
  let width = 900,
    height = 100;
  const places = new Map();
  function linkLabel(w) {
    return [w.fromEnd, w.label || w.kind, w.toEnd].filter(Boolean).join(' · ');
  }
  const identify = (shape, w) => {
    shape.setAttribute('data-wire', String(d.links.indexOf(w)));
    shape.setAttribute('data-active', String(d.links.indexOf(w) === settings.activeWire));
    shape.setAttribute('data-change', w.change || '');
    return shape;
  };
  const labelRows = [];
  function route(w, i) {
    const a = places.get(w.from),
      b = places.get(w.to);
    if (!a || !b) {
      return;
    }
    const x = a.x + a.w,
      y = a.y + a.h / 2,
      end = b.x + b.w,
      ey = b.y + b.h / 2;
    const channel = Math.max(x, end) + 24 + (i % 12) * 14;
    width = Math.max(width, channel + 175);
    const bend = a === b ? ey + 18 : ey;
    const p = element('path', {
      class: 'wire ' + (w.kind || ''),
      d: 'M ' + x + ' ' + y + ' H ' + channel + ' V ' + bend + ' H ' + end,
      fill: 'none',
    });
    identify(p, w);
    element('title', {}, linkLabel(w), p);
    if (d.kind === 'er') {
      crow(x, y, w.fromEnd);
      crow(end, bend, w.toEnd);
    } else if (d.kind === 'classes') {
      if (w.kind === 'composition') {
        element('path', { class: 'uml-end filled', d: 'M ' + x + ' ' + y + ' l 7 -5 7 5 -7 5 z' });
      } else if (['implements', 'inherits', 'realization', 'inheritance'].includes(w.kind)) {
        element('path', { class: 'uml-end', d: 'M ' + end + ' ' + bend + ' l 12 -7 v 14 z' });
      } else {
        element('path', { class: 'wire', fill: 'none', d: 'M ' + (end + 10) + ' ' + (bend - 5) + ' l -10 5 10 5' });
      }
    } else {
      text(end + 2, bend - 3, '◀');
    }
    const gutter = Math.max(...[...places.values()].map((p) => p.x + p.w)) + 52 + Math.min(d.links.length, 12) * 14;
    let row = (y + bend) / 2 - 3;
    while (labelRows.some((previous) => Math.abs(previous - row) < 18)) row += 18;
    labelRows.push(row);
    const caption = String(i + 1) + '. ' + linkLabel(w).slice(0, 42);
    const label = text(gutter, row, caption, 'edge-label');
    label.setAttribute('data-wire-label', String(i));
    width = Math.max(width, gutter + caption.length * 9 + 20);
    height = Math.max(height, row + 22);
  }
  function crow(x, y, cardinality) {
    if (!cardinality) {
      text(x + 2, y - 4, '?');
      return;
    }
    if (cardinality.endsWith('*')) {
      line(x, y - 7, x + 13, y);
      line(x, y + 7, x + 13, y);
    } else {
      line(x + 5, y - 7, x + 5, y + 7);
    }
    if (cardinality.startsWith('0')) {
      element('circle', { class: 'uml-end', cx: x + 21, cy: y, r: 4 });
    } else {
      line(x + 16, y - 7, x + 16, y + 7);
    }
  }
  function stages() {
    const shown = new Map(visible.map((p) => [p.id, p]));
    const edges = d.links.filter((w) => shown.has(w.from) && shown.has(w.to));
    const depth = new Map(),
      queue = visible.filter((p) => !edges.some((w) => w.to === p.id)).map((p) => p.id);
    if (!queue.length && visible.length) {
      queue.push(visible[0].id);
    }
    queue.forEach((id) => depth.set(id, 0));
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      for (const w of edges.filter((e) => e.from === id)) {
        if (!depth.has(w.to)) {
          depth.set(w.to, depth.get(id) + 1);
          queue.push(w.to);
        }
      }
    }
    const rows = new Map();
    const layouts = new Map(visible.map((part) => [part.id, cardLayout(part, 280)]));
    const rowHeight = Math.max(80, ...[...layouts.values()].map((layout) => layout.h)) + 60;
    visible.forEach((p) => {
      const col = depth.get(p.id) || 0,
        row = rows.get(col) || 0,
        x = 32 + col * 350,
        y = 55 + Math.min(d.links.length, 12) * 18 + row * rowHeight;
      rows.set(col, row + 1);
      places.set(p.id, { x, y, w: 280, h: layouts.get(p.id).h });
      width = Math.max(width, x + 320);
      height = Math.max(height, y + rowHeight);
    });
    for (const [i, w] of edges.entries()) {
      const a = places.get(w.from),
        b = places.get(w.to);
      if (a.x < b.x) {
        const x1 = a.x + a.w,
          y1 = a.y + a.h / 2,
          y2 = b.y + b.h / 2,
          mid = (x1 + b.x) / 2;
        identify(
          element('path', { class: 'wire', fill: 'none', d: 'M ' + x1 + ' ' + y1 + ' H ' + mid + ' V ' + y2 + ' H ' + b.x }),
          w,
        );
        text(b.x - 14, y2 - 2, '›');
        let labelY = Math.min(a.y, b.y) - 12;
        while (labelRows.some((previous) => Math.abs(previous - labelY) < 18)) { labelY -= 18; }
        labelRows.push(labelY);
        text(x1 + 3, labelY, w.label.slice(0, 24), 'edge-label');
      } else {
        route(w, i);
      }
    }
    visible.forEach((p) => {
      const a = places.get(p.id);
      hit(p, a.x, a.y, a.w, a.h, layouts.get(p.id));
    });
    if (d.kind === 'lifecycle') {
      for (const p of visible) {
        const a = places.get(p.id);
        if (p.id === '[start]' || p.id === '[end]') {
          element('circle', { cx: a.x + 13, cy: a.y - 13, r: 6, class: 'uml-end filled' });
          if (p.id === '[end]') {
            element('circle', { cx: a.x + 13, cy: a.y - 13, r: 10, class: 'uml-end outer' });
          }
        }
      }
    }
  }
  function cards() {
    let y = 25;
    const layouts = new Map();
    visible.forEach((p) => {
      const w = d.kind === 'er' || d.kind === 'classes' ? 460 : 320;
      const layout = cardLayout(p, w, settings.fields);
      layouts.set(p.id, layout);
      places.set(p.id, { x: 35, y, w, h: layout.h });
      y += layout.h + 38;
    });
    d.links.forEach(route);
    for (const p of visible) {
      const a = places.get(p.id);
      hit(p, a.x, a.y, a.w, a.h, layouts.get(p.id));
    }
    height = Math.max(height, y + 15);
  }
  function lanes() {
    const groups = [...new Set(visible.map((p) => p.group || 'Stage'))];
    const top = new Map(groups.map((g, i) => [g, i]));
    const counts = new Map();
    const ranks = new Map();
    const layouts = new Map(visible.map((part) => [part.id, cardLayout(part, 260)]));
    const laneHeight = Math.max(90, ...[...layouts.values()].map((layout) => layout.h), ...groups.map((group) => wrap(group, 120).length * 18)) + 60;
    for (const p of visible) {
      const group = p.group || 'Stage';
      const incoming = d.links.filter((l) => l.to === p.id && ranks.has(l.from)).map((l) => ranks.get(l.from) + 1);
      const col = Math.max(counts.get(group) || 0, ...incoming),
        x = 160 + col * 320,
        y = 38 + top.get(group) * laneHeight;
      ranks.set(p.id, col);
      counts.set(group, col + 1);
      places.set(p.id, { x, y, w: 260, h: layouts.get(p.id).h });
      width = Math.max(width, x + 300);
    }
    groups.forEach((g, i) => {
      wrap(g, 120).forEach((label, row) => text(10, 58 + i * laneHeight + row * 18, label));
      line(5, 18 + (i + 1) * laneHeight, width - 8, 18 + (i + 1) * laneHeight, 'lane');
    });
    for (const w of d.links) {
      const a = places.get(w.from),
        b = places.get(w.to);
      if (a && b) {
        const mid = (a.x + a.w + b.x) / 2;
        identify(
          element('path', {
            class: 'wire',
            fill: 'none',
            d: 'M ' + (a.x + a.w) + ' ' + (a.y + a.h / 2) + ' H ' + mid + ' V ' + (b.y + b.h / 2) + ' H ' + b.x,
          }),
          w,
        );
        text(b.x - 15, b.y + b.h / 2 - 3, '›');
      }
    }
    visible.forEach((p) => {
      const a = places.get(p.id);
      hit(p, a.x, a.y, a.w, a.h, layouts.get(p.id));
    });
    height = groups.length * laneHeight + 40;
  }
  function sequence() {
    const participants = new Map(visible.map((p, i) => [p.id, 162 + i * 320]));
    const layouts = new Map(visible.map((part) => [part.id, cardLayout(part, 276)]));
    const headerHeight = Math.max(90, ...[...layouts.values()].map((layout) => layout.h));
    const messages = d.links.filter((l) => participants.has(l.from) && participants.has(l.to));
    width = Math.max(width, visible.length * 320 + 24);
    let cursor = headerHeight + 56;
    messages.forEach((m, i) => {
      const a = participants.get(m.from),
        b = participants.get(m.to);
      const labelWidth = a === b ? 230 : Math.max(120, Math.abs(b - a) - 24);
      const labels = wrap(i + 1 + '. ' + (m.label || m.kind || 'Message'), labelWidth);
      const y = cursor + labels.length * 18;
      if (a === b) {
        identify(element('path', { class: 'wire', fill: 'none', d: 'M ' + a + ' ' + y + ' h 42 v 14 h -42' }), m);
        text(b + 3, y + 12, '‹');
        width = Math.max(width, a + labelWidth + 30);
      } else {
        identify(line(a, y, b, y, m.kind === 'return' ? 'lifeline' : 'wire'), m);
        text(b + (a < b ? -12 : 3), y - 2, a < b ? '›' : '‹');
      }
      labels.forEach((label, row) => {
        const caption = text(Math.min(a, b) + 8, cursor + row * 18, label, 'edge-label');
        caption.setAttribute('data-active', String(d.links.indexOf(m) === settings.activeWire));
      });
      cursor = y + 42;
    });
    height = cursor + 16;
    for (const p of visible) {
      const x = participants.get(p.id);
      line(x, 12 + headerHeight, x, height - 12, 'lifeline');
      hit(p, x - 138, 12, 276, headerHeight, layouts.get(p.id));
    }
  }
  function hierarchy() {
    const parent = settings.selected && d.items.find((p) => p.id === settings.selected);
    const level = settings.search
      ? visible
      : visible.filter((p) => (parent ? p.id === parent.id || p.parent === parent.id : !p.parent));
    let y = 20;
    for (const p of level) {
      const indent = parent && p.id !== parent.id ? 90 : 28;
      const layout = cardLayout(p, 400);
      if (indent > 30) {
        line(45, y + layout.h / 2, indent, y + layout.h / 2, 'wire');
      }
      places.set(p.id, { x: indent, y, w: 400, h: layout.h });
      hit(p, indent, y, 400, layout.h, layout);
      y += layout.h + 30;
    }
    d.links.forEach(route);
    height = y + 15;
  }
  function timeAxis() {
    const ordered = [...visible].sort((a, b) => a.start - b.start);
    if (!ordered.length) {
      return;
    }
    const spans = d.kind === 'waterfall',
      first = ordered[0].start,
      last = Math.max(...ordered.map((p) => (spans ? p.end : p.start)));
    const range = Math.max(1, last - first);
    const gaps = [];
    for (let i = 1; i < ordered.length; i++) {
      const gap = ordered[i].start - ordered[i - 1].start;
      if (!spans && gap > 86400000 * 7) {
        gaps.push([ordered[i - 1].start, gap]);
      }
    }
    const project = (t) =>
      t - first - gaps.reduce((sum, [start, gap]) => sum + Math.min(Math.max(0, t - start), gap) * (1 - 86400000 / gap), 0);
    const pos = (t) => 360 + (590 * project(t)) / Math.max(1, project(last));
    const fmt = (t) =>
      spans
        ? String(Math.round((t - first) * 100) / 100) + ' ms'
        : new Date(t).toLocaleString(undefined, { timeZone: settings.zone === 'UTC' ? 'UTC' : undefined });
    text(355, 22, fmt(first));
    text(810, 22, fmt(last));
    line(358, 35, 955, 35, 'wire');
    width = Math.max(width, 1040);
    gaps.forEach(([start, gap]) => {
      text(pos(start) + 3, 52, '// ' + Math.round(gap / 86400000) + 'd');
    });
    let cursor = 65;
    ordered.forEach((p) => {
      const layout = cardLayout(p, p.parent ? 300 : 317);
      const y = cursor + layout.h / 2 - 7, x = pos(p.start);
      hit(p, p.parent ? 25 : 8, cursor, p.parent ? 300 : 317, layout.h, layout);
      line(355, y + 7, 955, y + 7, 'lane');
      const g = element('rect', {
        x,
        y,
        width: spans ? Math.max(3, (590 * (p.end - p.start)) / range) : 7,
        height: 15,
        class: 'timebar ' + palette(p.group),
      });
      g.addEventListener('click', () => select(p.id));
      element('title', {}, spans ? String(p.end - p.start) + ' ms' : fmt(p.start), g);
      cursor += layout.h + 20;
    });
    height = cursor + 20;
  }
  svg.replaceChildren();
  svg.setAttribute('data-kind', d.kind);
  if (d.kind === 'workflow') {
    lanes();
  } else if (d.kind === 'lifecycle' || d.kind === 'dataflow' || (d.kind === 'architecture' && !visible.some((p) => p.parent))) {
    stages();
  } else if (d.kind === 'sequence') {
    sequence();
  } else if (d.kind === 'waterfall' || d.kind === 'timeline') {
    timeAxis();
  } else if (d.kind === 'tree' || (d.kind === 'architecture' && visible.some((p) => p.parent))) {
    hierarchy();
  } else {
    cards();
  }
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  svg.setAttribute('width', String(width * settings.zoom));
  svg.setAttribute('height', String(height * settings.zoom));
  if (focused) { [...svg.querySelectorAll('[data-item]')].find((item) => item.getAttribute('data-item') === focused)?.focus(); }
};
