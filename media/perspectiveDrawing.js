/* Layout coordinates are shared by live and still display. All repository strings are text nodes. */
globalThis.drawMaltPerspective = function (svg, d, visible, select, settings) {
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
  const palette = (group) => {
    let h = 0;
    for (const c of group || 'component') {
      h = (31 * h + c.charCodeAt(0)) | 0;
    }
    return 'role' + String(Math.abs(h) % 7);
  };
  function hit(part, x, y, width, height, lines) {
    const g = element('g', {
      class: 'model-card ' + palette(part.group) + (settings.selected === part.id ? ' selected' : ''),
      role: 'button',
      tabindex: 0,
      'aria-label': part.label,
      'data-item': part.id,
      'data-change': part.change || '',
    });
    element('title', {}, [part.label, part.detail, ...(part.fields || [])].filter(Boolean).join('\n'), g);
    element('rect', { x, y, width, height, rx: 5 }, undefined, g);
    for (const [i, value] of lines.entries()) {
      const limit = Math.max(4, Math.floor((width - 18) / 7));
      element(
        'text',
        { x: x + 9, y: y + 18 + 17 * i, class: i ? 'caption' : 'card-title' },
        value.length > limit ? value.slice(0, limit - 1) + '…' : value,
        g,
      );
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
    visible.forEach((p) => {
      const col = depth.get(p.id) || 0,
        row = rows.get(col) || 0,
        x = 32 + col * 250,
        y = 55 + row * 98;
      rows.set(col, row + 1);
      places.set(p.id, { x, y, w: 174, h: 46 });
      width = Math.max(width, x + 220);
      height = Math.max(height, y + 95);
    });
    for (const [i, w] of edges.entries()) {
      const a = places.get(w.from),
        b = places.get(w.to);
      if (a.x < b.x) {
        const x1 = a.x + a.w,
          y1 = a.y + 21,
          y2 = b.y + 21,
          mid = (x1 + b.x) / 2;
        identify(
          element('path', { class: 'wire', fill: 'none', d: 'M ' + x1 + ' ' + y1 + ' H ' + mid + ' V ' + y2 + ' H ' + b.x }),
          w,
        );
        text(b.x - 14, y2 - 2, '›');
        text(x1 + 3, Math.min(a.y, b.y) - 8, w.label.slice(0, 24), 'edge-label');
      } else {
        route(w, i);
      }
    }
    visible.forEach((p) => {
      const a = places.get(p.id);
      hit(p, a.x, a.y, a.w, a.h, [p.label, p.group || '']);
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
    visible.forEach((p) => {
      const fields = settings.fields ? p.fields || [] : [];
      const h = 32 + 17 * fields.length;
      const x = d.kind === 'dataflow' ? 35 + 85 * (Math.max(0, [...new Set(visible.map((i) => i.group))].indexOf(p.group)) % 4) : 35;
      const w = d.kind === 'er' || d.kind === 'classes' ? 440 : 250;
      places.set(p.id, { x, y, w, h });
      y += h + 30;
    });
    d.links.forEach(route);
    for (const p of visible) {
      const a = places.get(p.id);
      hit(p, a.x, a.y, a.w, a.h, [p.label, ...(settings.fields ? p.fields || [] : [])]);
    }
    height = Math.max(height, y + 15);
  }
  function lanes() {
    const groups = [...new Set(visible.map((p) => p.group || 'Stage'))];
    const top = new Map(groups.map((g, i) => [g, i]));
    const counts = new Map();
    const ranks = new Map();
    for (const p of visible) {
      const group = p.group || 'Stage';
      const incoming = d.links.filter((l) => l.to === p.id && ranks.has(l.from)).map((l) => ranks.get(l.from) + 1);
      const col = Math.max(counts.get(group) || 0, ...incoming),
        x = 145 + col * 194,
        y = 38 + top.get(group) * 94;
      ranks.set(p.id, col);
      counts.set(group, col + 1);
      places.set(p.id, { x, y, w: 158, h: 36 });
      width = Math.max(width, x + 195);
    }
    groups.forEach((g, i) => {
      text(10, 58 + i * 94, g);
      line(5, 88 + i * 94, width - 8, 88 + i * 94, 'lane');
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
            d: 'M ' + (a.x + a.w) + ' ' + (a.y + 17) + ' H ' + mid + ' V ' + (b.y + 17) + ' H ' + b.x,
          }),
          w,
        );
        text(b.x - 15, b.y + 14, '›');
      }
    }
    visible.forEach((p) => {
      const a = places.get(p.id);
      hit(p, a.x, a.y, a.w, a.h, [p.label]);
    });
    height = groups.length * 94 + 25;
  }
  function sequence() {
    const participants = new Map(visible.map((p, i) => [p.id, 105 + i * 185]));
    const messages = d.links.filter((l) => participants.has(l.from) && participants.has(l.to));
    width = Math.max(width, visible.length * 185 + 55);
    height = 100 + messages.length * 47;
    for (const p of visible) {
      const x = participants.get(p.id);
      line(x, 54, x, height - 12, 'lifeline');
      hit(p, x - 78, 12, 156, 37, [p.label]);
    }
    messages.forEach((m, i) => {
      const a = participants.get(m.from),
        b = participants.get(m.to),
        y = 86 + 47 * i;
      if (a === b) {
        identify(element('path', { class: 'wire', fill: 'none', d: 'M ' + a + ' ' + y + ' h 42 v 14 h -42' }), m);
      } else {
        identify(line(a, y, b, y, m.kind === 'return' ? 'lifeline' : 'wire'), m);
      }
      text(b + (a < b ? -12 : 3), y - 2, a < b ? '›' : '‹');
      text(Math.min(a, b) + 7, y - 7, i + 1 + '. ' + m.label, 'edge-label');
    });
  }
  function hierarchy() {
    const parent = settings.selected && d.items.find((p) => p.id === settings.selected);
    const level = settings.search
      ? visible
      : visible.filter((p) => (parent ? p.id === parent.id || p.parent === parent.id : !p.parent));
    let y = 20;
    for (const p of level) {
      const indent = parent && p.id !== parent.id ? 90 : 28;
      if (indent > 30) {
        line(45, y + 15, indent, y + 15, 'wire');
      }
      places.set(p.id, { x: indent, y, w: 355, h: 38 });
      hit(p, indent, y, 355, 38, [p.label]);
      y += 55;
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
    const pos = (t) => 240 + (590 * project(t)) / Math.max(1, project(last));
    const fmt = (t) =>
      spans
        ? String(Math.round((t - first) * 100) / 100) + ' ms'
        : new Date(t).toLocaleString(undefined, { timeZone: settings.zone === 'UTC' ? 'UTC' : undefined });
    text(235, 22, fmt(first));
    text(690, 22, fmt(last));
    line(238, 35, 835, 35, 'wire');
    gaps.forEach(([start, gap]) => {
      text(pos(start) + 3, 52, '// ' + Math.round(gap / 86400000) + 'd');
    });
    ordered.forEach((p, i) => {
      const y = 65 + i * 38,
        x = pos(p.start);
      hit(p, p.parent ? 25 : 8, y - 7, p.parent ? 198 : 215, 30, [p.label]);
      line(235, y + 7, 835, y + 7, 'lane');
      const g = element('rect', {
        x,
        y,
        width: spans ? Math.max(3, (590 * (p.end - p.start)) / range) : 7,
        height: 15,
        class: 'timebar ' + palette(p.group),
      });
      g.addEventListener('click', () => select(p.id));
      element('title', {}, spans ? String(p.end - p.start) + ' ms' : fmt(p.start), g);
    });
    height = 95 + ordered.length * 38;
  }
  svg.replaceChildren();
  svg.setAttribute('data-kind', d.kind);
  if (d.kind === 'workflow') {
    lanes();
  } else if (d.kind === 'lifecycle' || d.kind === 'dataflow') {
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
};
