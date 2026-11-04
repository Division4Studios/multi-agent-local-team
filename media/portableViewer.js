(() => {
  'use strict';
  const el = (id) => document.getElementById(id);
  const make = (tag, text) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const model = JSON.parse(el('malt-source').textContent),
    diagrams = model.diagrams || [];
  const opts = (node, pairs) => {
    node.replaceChildren();
    for (const [value, label] of pairs) {
      const o = make('option', label);
      o.value = value;
      node.append(o);
    }
  };
  let index = 0,
    id,
    at = -1,
    route = [],
    journeys = [],
    timer,
    scope,
    locale = model.meta?.locale || 'en',
    panel = model.answer?.panels[0],
    d;
  let highlighted = '';
  const stop = () => {
    window.clearInterval(timer);
    timer = undefined;
  };
  const languages = window.maltLabels,
    custom = model.meta?.translations || {};
  const t = (k) => String(custom[locale]?.[k] ?? languages[locale]?.[k] ?? languages.en[k] ?? k);
  function translate() {
    document.documentElement.lang = locale;
    for (const n of document.querySelectorAll('[data-label]')) n.textContent = t(n.dataset.label);
    el('find').placeholder = t('find');
  }
  function card(parent, source) {
    if (!source) return;
    const repo = source.repository ?? model.meta?.repository,
      label = source.path + (source.line ? ' · ' + source.line : '');
    if (repo) {
      const url =
        repo.url +
        (repo.url.startsWith('https://gitlab.com/') ? '/-/blob/' : '/blob/') +
        repo.revision +
        '/' +
        source.path.split('/').map(encodeURIComponent).join('/') +
        (source.line ? '#L' + source.line : '');
      const link = make('a', label);
      link.href = url;
      link.rel = 'noopener noreferrer';
      parent.append(link);
    } else {
      parent.append(make('span', label));
    }
    if (source.quote) parent.append(make('blockquote', source.quote));
  }
  function info() {
    const p = d?.items.find((i) => i.id === id) || panel,
      box = el('detail');
    box.replaceChildren();
    if (!p) return;
    box.append(make('h2', p.label || p.title));
    if (p.change) box.append(make('strong', p.change));
    if (p.detail || p.body) box.append(make('p', p.detail || p.body));
    if (p.fields?.length) box.append(make('pre', p.fields.join('\n')));
    card(box, p.source);
    if (p.ref)
      diagrams.forEach((other, i) => {
        if (i === index) return;
        const match = other.items.find((v) => v.ref === p.ref);
        if (!match) return;
        const btn = make('button', other.title);
        btn.onclick = () => open(i, match.id);
        box.append(btn);
      });
  }
  function draw() {
    if (!d) return;
    const svg = el('modelSvg'),
      filter = el('find').value.trim().toLowerCase();
    const visible = filter
      ? d.items.filter((p) => (p.label + ' ' + (p.group || '') + ' ' + (p.detail || '')).toLowerCase().includes(filter))
      : d.items;
    window.drawMaltPerspective(svg, d, visible, select, {
      selected: scope,
      search: !!filter,
      fields: el('fields').checked,
      zone: el('zone').value,
      zoom: Number(el('zoom').value),
    });
    svg.dataset.motion = el('motion').checked ? 'live' : 'still';
    for (const g of svg.querySelectorAll('[data-item]')) g.classList.toggle('selected', g.dataset.item === id);
    for (const edge of svg.querySelectorAll('[data-wire]')) edge.classList.toggle('active', Number(edge.dataset.wire) === route[at]);
    const groups = new Map();
    for (const p of visible) {
      if (!groups.has(p.group || 'Component')) groups.set(p.group || 'Component', true);
    }
    const legend = el('legend');
    legend.replaceChildren();
    for (const label of groups.keys()) {
      let h = 0;
      for (const c of label === 'Component' ? 'component' : label) h = (h * 31 + c.charCodeAt(0)) | 0;
      const n = make('span', label);
      n.className = 'role' + (Math.abs(h) % 7);
      legend.append(n);
    }
  }
  function select(value) {
    id = value;
    scope = value;
    el('part').value = value;
    info();
    draw();
  }
  function open(i, selected) {
    stop();
    index = i;
    d = diagrams[i];
    el('view').value = String(i);
    document.title = d.title;
    el('title').textContent = d.title;
    opts(
      el('part'),
      d.items.map((p) => [p.id, p.label]),
    );
    id = selected ?? d.items.find((p) => !p.parent)?.id ?? d.items[0].id;
    scope = id;
    el('part').value = id;
    el('find').value = '';
    journeys = [];
    d.links.forEach((wire, n) => {
      const last = journeys[journeys.length - 1];
      if (last && d.links[last[last.length - 1]].to === wire.from) last.push(n);
      else journeys.push([n]);
    });
    opts(
      el('journey'),
      journeys.map((path, n) => [
        String(n),
        d.items.find((p) => p.id === d.links[path[0]].from).label +
          ' → ' +
          d.items.find((p) => p.id === d.links[path[path.length - 1]].to).label,
      ]),
    );
    route = journeys[0] || [];
    at = -1;
    refreshJourney();
    draw();
    info();
  }
  function refreshJourney() {
    const list = el('routes');
    list.replaceChildren();
    route.forEach((n, i) => {
      const w = d.links[n],
        b = make(
          'button',
          i +
            1 +
            '. ' +
            d.items.find((p) => p.id === w.from).label +
            ' → ' +
            d.items.find((p) => p.id === w.to).label +
            ' · ' +
            w.label,
        );
      b.setAttribute('aria-current', String(at === i));
      b.onclick = () => {
        stop();
        inspect(i);
      };
      const li = make('li');
      li.append(b);
      list.append(li);
    });
    for (const key of ['play', 'prev', 'next']) el(key).disabled = !route.length;
  }
  function inspect(i) {
    if (i < 0 || i >= route.length) return;
    at = i;
    select(d.links[route[at]].to);
    refreshJourney();
  }
  function play() {
    stop();
    if (at >= route.length - 1) at = -1;
    inspect(at + 1);
    if (at < route.length - 1)
      timer = window.setInterval(() => {
        inspect(at + 1);
        if (at >= route.length - 1) stop();
      }, 850);
  }
  function answers() {
    const container = el('answers');
    for (const p of model.answer.panels) {
      const article = make('article');
      article.tabIndex = 0;
      article.append(make('h2', p.title), make('p', p.body));
      card(article, p.source);
      const choose = () => {
        panel = p;
        info();
      };
      article.onclick = choose;
      article.onfocus = choose;
      container.append(article);
    }
    el('title').textContent = model.answer.title;
    info();
  }
  opts(
    el('language'),
    [...new Set([...Object.keys(languages), ...Object.keys(custom)])].map((k) => [k, k]),
  );
  if (!languages[locale] && !custom[locale]) locale = 'en';
  el('language').value = locale;
  translate();
  el('language').onchange = (e) => {
    locale = e.target.value;
    translate();
  };
  el('theme').onchange = (e) => {
    if (e.target.value === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = e.target.value;
  };
  el('motion').checked = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (const key of ['motion', 'fields', 'zoom', 'zone']) el(key).onchange = draw;
  el('find').oninput = draw;
  el('part').onchange = (e) => select(e.target.value);
  el('view').onchange = (e) => open(Number(e.target.value));
  el('parent').onclick = () => {
    const p = d.items.find((i) => i.id === id);
    if (p?.parent) select(p.parent);
  };
  el('journey').onchange = (e) => {
    stop();
    route = journeys[Number(e.target.value)] || [];
    at = -1;
    refreshJourney();
    draw();
  };
  el('play').onclick = play;
  el('pause').onclick = stop;
  el('prev').onclick = () => {
    stop();
    inspect(Math.max(0, at - 1));
  };
  el('next').onclick = () => {
    stop();
    inspect(Math.min(route.length - 1, at + 1));
  };
  document.addEventListener('selectionchange', () => {
    const v = String(window.getSelection()).trim();
    if (v) highlighted = v.slice(0, 4000);
  });
  el('ask').onclick = async () => {
    const p = d?.items.find((i) => i.id === id) || panel;
    const message = [t('prompt'), document.title, 'ID ' + p.id, p.label || p.title, p.detail || p.body || '', highlighted]
      .filter(Boolean)
      .join('\n');
    el('prompt').hidden = false;
    el('prompt').value = message;
    try {
      await window.navigator.clipboard.writeText(message);
    } catch {
      el('prompt').select();
    }
  };
  if (diagrams.length) {
    opts(
      el('view'),
      diagrams.map((m, i) => [String(i), m.kind + ' · ' + m.title]),
    );
    open(0);
  } else {
    el('diagram').hidden = true;
    answers();
  }
  el('save').onclick = async () => {
    const b = el('save');
    b.disabled = true;
    try {
      await window.maltExport(el('format').value, Number(el('scale').value), d, route, inspect);
      el('status').textContent = '✓';
    } catch (e) {
      el('status').textContent = String(e);
    } finally {
      b.disabled = false;
    }
  };
  if (window.location.search === '?malt-check') window.maltBrowserProbe(model);
})();
