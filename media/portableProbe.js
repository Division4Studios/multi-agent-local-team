window.maltBrowserProbe = function (model) {
  const el = (id) => document.getElementById(id);
  const checks = {};
  let smallest = null;
  try {
    checks.pageFits = document.documentElement.scrollWidth <= window.innerWidth + 1;
    const theme = el('theme');
    theme.value = 'dark';
    theme.dispatchEvent(new window.Event('change'));
    checks.themeControl = document.documentElement.dataset.theme === 'dark';
    const box = el('legend').getBoundingClientRect(),
      canvas = el('modelDrawing').getBoundingClientRect();
    checks.legendClearance = !model.diagrams || box.top >= canvas.bottom - 1;
    if (model.diagrams) {
      checks.views = true;
      checks.nodeInteraction = true;
      checks.labelsFit = true;
      checks.pinnedSources = true;
      checks.routeControl = true;
      model.diagrams.forEach((d, i) => {
        el('view').value = String(i);
        el('view').dispatchEvent(new window.Event('change'));
        checks.views &&= el('modelSvg').dataset.kind === d.kind;
        const nodes = el('modelSvg').querySelectorAll('[data-item]');
        checks.nodeInteraction &&= nodes.length > 0;
        for (const node of nodes) {
          const r = node.querySelector('rect').getBBox();
          for (const text of node.querySelectorAll('text')) {
            const b = text.getBBox(),
              size = parseFloat(window.getComputedStyle(text).fontSize);
            smallest = smallest === null ? size : Math.min(smallest, size);
            checks.labelsFit &&=
              b.x >= r.x && b.y >= r.y - 1 && b.x + b.width <= r.x + r.width + 1 && b.y + b.height <= r.y + r.height + 1;
          }
        }
        nodes[nodes.length - 1]?.dispatchEvent(new window.MouseEvent('click'));
        checks.nodeInteraction &&= el('detail').textContent.includes(el('part').selectedOptions[0].textContent);
        const selected = d.items.find((p) => p.id === el('part').value),
          card = selected?.source;
        const repo = card?.repository ?? model.meta?.repository;
        if (card && repo) {
          const href = el('detail').querySelector('a')?.href;
          checks.pinnedSources &&=
            typeof href === 'string' && href.startsWith(repo.url + '/') && href.includes('/' + repo.revision + '/');
        }
        if (d.links.length) {
          el('next').click();
          checks.routeControl &&= !!el('routes').querySelector('[aria-current="true"]');
        }
      });
      checks.readable = smallest >= 10;
      checks.exportControls = ['png', 'jpeg', 'webp', 'svg', 'webm', 'clipboard'].every((v) =>
        [...el('format').options].some((o) => o.value === v),
      );
    } else {
      checks.panels = el('answers').querySelectorAll(':scope > article').length === model.answer.panels.length;
    }
  } catch (error) {
    checks.exception = String(error);
  }
  const result = {
    width: window.innerWidth,
    height: window.innerHeight,
    smallestTextPx: smallest,
    checks,
    pass: Object.values(checks).every((v) => v === true),
  };
  const marker = document.createElement('meta');
  marker.name = 'malt-browser-result';
  marker.content = window.btoa(JSON.stringify(result));
  document.head.append(marker);
};
