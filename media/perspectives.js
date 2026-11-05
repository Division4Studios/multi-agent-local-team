window.startMaltViews = function (send, graphVisit) {
  const el = (id) => document.getElementById(id);
  const kind = el('modelKind'),
    subject = el('modelSubject'),
    info = el('modelDetail');
  let state,
    zoom = 1,
    offset = 0,
    playing,
    step = -1,
    last = '',
    trail = [];
  const controls = (parent, label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', fn);
    parent.append(b);
  };
  const option = (list, value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    list.append(o);
  };
  const visit = (item, key = state.place.key, k = state.place.kind) => send({ action: 'perspective', kind: k, key, item });
  const inspect = (item) => { reset(); visit(item); };
  function stop() {
    window.clearInterval(playing);
    playing = undefined;
    el('modelPlay').textContent = step >= trail.length - 1 && trail.length ? 'Replay' : step >= 0 ? 'Resume' : 'Play route';
    el('modelSvg').setAttribute('data-motion', 'still');
  }
  function draw() {
    if (!state) {
      return;
    }
    const d = state.model;
    const sel = state.place.item;
    const original = d && d.kind === 'architecture' && d.id === 'project' && !d.path;
    el('connectionMap').hidden = !original;
    el('modelScreen').hidden = Boolean(original);
    el('relatedModels').replaceChildren();
    for (const link of state.related) {
      controls(el('relatedModels'), link.label, () => visit(link.place.item, link.place.key, link.place.kind));
    }
    if (original) {
      if (sel) {
        graphVisit(sel);
      }
      return;
    }
    info.replaceChildren();
    if (!d) {
      el('modelSvg').replaceChildren();
      el('modelCount').textContent = state.empty;
      el('modelLegend').replaceChildren();
      el('modelUp').disabled = el('modelPrev').disabled = el('modelNext').disabled = true;
      el('modelZone').hidden = el('modelFieldsWrap').hidden = true;
      renderRoute();
      return;
    }
    const q = el('modelSearch').value.toLowerCase();
    let matches = d.items.filter((p) => !q || (p.label + ' ' + (p.group || '') + ' ' + (p.detail || '')).toLowerCase().includes(q));
    const p = d.items.find((i) => i.id === sel);
    if ((d.kind === 'tree' || d.kind === 'architecture') && d.items.some((i) => i.parent) && !q && !trail.length) {
      matches = matches.filter((i) => (p ? i.id === p.id || i.parent === p.id : !i.parent));
    }
    if (offset >= matches.length) {
      offset = 0;
    }
    const subset = matches.slice(offset, offset + 60);
    const active = trail[step];
    for (const id of active ? [active.from, active.to] : []) {
      const part = d.items.find((item) => item.id === id);
      if (part && !subset.includes(part)) { subset.push(part); }
    }
    window.drawMaltPerspective(el('modelSvg'), d, subset, inspect, {
      selected: q ? '' : sel,
      zoom,
      fields: el('modelFields').checked,
      zone: el('modelZone').value,
      search: Boolean(q) || trail.length > 0,
      activeWire: active ? d.links.indexOf(active) : -1,
    });
    el('modelCount').textContent = matches.length
      ? String(offset + 1) + '–' + String(Math.min(offset + 60, matches.length)) + ' of ' + String(matches.length)
      : 'No matching items.';
    el('modelPrev').disabled = !offset;
    el('modelNext').disabled = offset + 60 >= matches.length;
    el('modelUp').disabled = !p?.parent;
    el('modelZone').hidden = d.kind !== 'timeline';
    el('modelFieldsWrap').hidden = d.kind !== 'er' && d.kind !== 'classes';
    el('modelLegend').replaceChildren();
    for (const group of [...new Set(d.items.map((i) => i.group || 'Component'))]) {
      const key = document.createElement('span');
      key.className = 'legend-key ' + window.maltPalette(group === 'Component' ? '' : group);
      key.textContent = group;
      el('modelLegend').append(key);
    }
    if (p) {
      const heading = document.createElement('h3');
      heading.textContent = p.label;
      info.append(heading);
      for (const value of [p.summary, p.explanationKind, p.group, p.detail, ...(el('modelFields').checked ? p.fields || [] : [])].filter(Boolean)) {
        const entry = document.createElement('div');
        entry.textContent = value;
        info.append(entry);
      }
      for (const w of d.links.filter((l) => l.from === p.id || l.to === p.id)) {
        const peer = d.items.find((i) => i.id === (w.from === p.id ? w.to : w.from));
        if (peer) {
          controls(
            info,
            (w.from === p.id ? '→ ' : '← ') + peer.label + ' · ' + [w.fromEnd, w.label, w.toEnd].filter(Boolean).join(' '),
            () => inspect(peer.id),
          );
        }
      }
      if (state.source) {
        controls(info, 'Open source', () => send({ action: 'viewSource' }));
      }
      if (state.discuss) {
        controls(info, 'Discuss this panel', () => send({ action: 'viewDiscuss' }));
      }
    } else {
      const hint = document.createElement('p');
      hint.textContent = 'Select a component to see its purpose, connections, and source.';
      info.append(hint);
    }
    renderRoute();
  }
  el('modelStill').checked = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const motion = () => el('modelSvg').setAttribute('data-motion', el('modelStill').checked || !playing ? 'still' : 'live');
  el('modelStill').addEventListener('change', motion);
  motion();
  kind.addEventListener('change', () => visit('', '', kind.value));
  subject.addEventListener('change', () => visit('', subject.value));
  el('modelPrompt').addEventListener('click', () =>
    send({ action: 'viewPrompt', passage: String(window.getSelection() || '').slice(0, 1600) }),
  );
  el('modelBack').addEventListener('click', () => send({ action: 'viewBack' }));
  el('modelTray').addEventListener('click', () => send({ action: 'viewTray' }));
  el('modelSide').addEventListener('click', () => send({ action: 'viewSide' }));
  el('modelExport').addEventListener('click', () => send({ action: 'viewExport' }));
  el('modelPrev').addEventListener('click', () => {
    offset = Math.max(0, offset - 60);
    draw();
  });
  el('modelNext').addEventListener('click', () => {
    offset += 60;
    draw();
  });
  el('modelZoom').addEventListener('change', () => {
    zoom = Number(el('modelZoom').value);
    draw();
  });
  el('modelUp').addEventListener('click', () => inspect(state.model?.items.find((i) => i.id === state.place.item)?.parent || ''));
  el('modelSearch').addEventListener('input', () => {
    offset = 0;
    draw();
  });
  for (const id of ['modelFields', 'modelZone']) {
    el(id).addEventListener('change', draw);
  }
  function buildRoute() {
    const d = state?.model;
    if (!d) { return []; }
    if (d.kind === 'sequence') { return d.links.slice(); }
    let next = state.place.item ? d.links.find((w) => w.from === state.place.item) : d.links[0];
    const route = [];
    while (next && !route.includes(next)) {
      route.push(next);
      next = d.links.find((w) => w.from === next.to && !route.includes(w));
    }
    return route;
  }
  function reset() { trail = []; step = -1; stop(); }
  function advance() {
    if (!trail.length) { trail = buildRoute(); }
    if (!trail.length || step >= trail.length - 1) { stop(); renderRoute(); return; }
    step++;
    el('modelSearch').value = '';
    visit(trail[step].to);
    draw();
    if (step === trail.length - 1) { stop(); }
  }
  function renderRoute() {
    const d = state?.model, available = trail.length ? trail : buildRoute();
    const steps = el('modelSteps');
    const focusedStep = steps.contains?.(document.activeElement) ? document.activeElement?.getAttribute('data-step') : undefined;
    el('modelPlay').disabled = !available.length;
    el('modelStep').disabled = !available.length || (trail.length > 0 && step === trail.length - 1);
    el('modelReset').disabled = !trail.length;
    steps.replaceChildren();
    const name = (id) => d?.items.find((item) => item.id === id)?.label || id;
    const describe = (wire) => name(wire.from) + ' → ' + name(wire.to) + ' · ' + (wire.label || wire.kind || 'connects');
    const current = trail[step];
    el('modelRoute').textContent = current
      ? (step === trail.length - 1 ? 'Complete · ' : '') + 'Step ' + (step + 1) + ' of ' + trail.length + ': ' + describe(current)
      : available.length ? (d?.kind === 'sequence' ? 'Play messages in their authored order.' : 'Follow a directed route from the selected component. At a branch, the first listed connection is followed.') : d ? 'No outgoing route from this selection.' : 'No diagram is available to play.';
    trail.forEach((wire, index) => {
      const row = document.createElement('li'), button = document.createElement('button');
      button.textContent = describe(wire);
      button.setAttribute('data-step', String(index));
      button.setAttribute('aria-current', index === step ? 'step' : 'false');
      button.addEventListener('click', () => { stop(); step = index - 1; advance(); });
      row.append(button); steps.append(row);
    });
    if (focusedStep !== undefined) {
      [...steps.querySelectorAll('[data-step]')].find((button) => button.getAttribute('data-step') === focusedStep)?.focus({ preventScroll: true });
    }
  }
  function resumeRoute() {
    if (!trail.length) { trail = buildRoute(); }
    if (!trail.length) { return; }
    if (step >= trail.length - 1) { step = -1; }
    playing = window.setInterval(advance, Number(el('modelSpeed').value));
    advance();
    if (playing) { el('modelPlay').textContent = 'Pause'; }
    motion();
  }
  el('modelPlay').addEventListener('click', () => { if (playing) { stop(); } else { resumeRoute(); } });
  el('modelStep').addEventListener('click', () => { stop(); advance(); });
  el('modelReset').addEventListener('click', () => {
    const start = trail[0]?.from;
    reset();
    if (start) { visit(start); }
    draw();
  });
  el('modelSpeed').addEventListener('change', () => {
    if (playing) {
      window.clearInterval(playing);
      playing = window.setInterval(advance, Number(el('modelSpeed').value));
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stop(); } });
  return (m) => {
    if (trail.length && m.place.item !== trail[step]?.to) { reset(); }
    state = m;
    const identity = JSON.stringify([m.place.kind, m.place.key, m.side, m.model?.links]);
    if (last !== identity) {
      reset();
      offset = 0;
      el('modelSearch').value = '';
      last = identity;
    }
    kind.replaceChildren();
    for (const [k, label] of m.kinds) {
      option(kind, k, label);
    }
    kind.value = m.place.kind;
    subject.replaceChildren();
    for (const item of m.menu) {
      option(subject, item.key, item.title);
    }
    subject.value = m.place.key;
    el('modelQuestion').textContent = m.question;
    el('modelSide').hidden = !m.compare;
    el('modelSide').textContent = m.side === 'base' ? 'Showing base · switch to target' : 'Showing target · switch to base';
    draw();
  };
};
