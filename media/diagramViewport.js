/* Native scroll space leaves room to center any part of a diagram, including its edges. */
window.startMaltViewport = function (viewport, centerButton) {
  if (!viewport) return;
  const svg = viewport.querySelector('svg');
  const stage = document.createElement('div');
  stage.className = 'diagram-stage';
  stage.append(svg);
  viewport.append(stage);
  let drag, space = false, suppressClick = false, initialized = false, extent = '';
  const center = () => {
    viewport.scrollLeft = (viewport.scrollWidth - viewport.clientWidth) / 2;
    viewport.scrollTop = (viewport.scrollHeight - viewport.clientHeight) / 2;
  };
  const resize = () => {
    if (!viewport.clientWidth || !viewport.clientHeight) return;
    const dx = viewport.clientWidth - (Number.parseFloat(stage.style.getPropertyValue('--pan-x')) || 0);
    const dy = viewport.clientHeight - (Number.parseFloat(stage.style.getPropertyValue('--pan-y')) || 0);
    stage.style.setProperty('--pan-x', viewport.clientWidth + 'px');
    stage.style.setProperty('--pan-y', viewport.clientHeight + 'px');
    const size = svg.getAttribute('width') + ':' + svg.getAttribute('height');
    if (!initialized || size !== extent) { center(); initialized = true; extent = size; }
    else { viewport.scrollLeft += dx; viewport.scrollTop += dy; }
  };
  const finish = () => {
    const pointer = drag?.id;
    drag = undefined;
    viewport.classList.remove('is-panning');
    if (pointer !== undefined && viewport.hasPointerCapture(pointer)) viewport.releasePointerCapture(pointer);
  };
  const resetKeys = () => {
    space = false;
    viewport.classList.remove('pan-ready');
    finish();
  };
  viewport.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse' || drag) return;
    suppressClick = false;
    const control = event.target.closest('button, a, input, select, textarea, [contenteditable="true"]');
    const item = event.target.closest('[data-item]');
    if (control || (event.button !== 1 && !(event.button === 0 && (space || !item)))) return;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    drag = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY,
      left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    viewport.classList.add('is-panning');
  });
  viewport.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (!(event.buttons & (drag.button === 1 ? 4 : 1))) { finish(); return; }
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (drag.button === 0 && Math.abs(dx) + Math.abs(dy) > 3) suppressClick = true;
    viewport.scrollLeft = drag.left - dx;
    viewport.scrollTop = drag.top - dy;
    event.preventDefault();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    viewport.addEventListener(name, event => { if (event.pointerId === drag?.id) finish(); });
  }
  viewport.addEventListener('click', event => {
    if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
  }, true);
  viewport.addEventListener('auxclick', event => { if (event.button === 1) event.preventDefault(); });
  viewport.addEventListener('keydown', event => {
    if (event.target !== viewport || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code === 'Space') {
      space = true; viewport.classList.add('pan-ready'); event.preventDefault();
    }
    const moves = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, -80], ArrowDown: [0, 80] };
    if (moves[event.key]) {
      const [x, y] = moves[event.key];
      viewport.scrollLeft += x; viewport.scrollTop += y; event.preventDefault();
    }
    if (event.key === 'Home') { center(); event.preventDefault(); }
    if (event.key === 'Escape') resetKeys();
  });
  viewport.addEventListener('keyup', event => { if (event.code === 'Space') resetKeys(); });
  viewport.addEventListener('blur', resetKeys);
  window.addEventListener('blur', resetKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetKeys(); });
  centerButton?.addEventListener('click', center);
  const observer = new window.ResizeObserver(resize);
  observer.observe(viewport);
  observer.observe(svg);
  resize();
  window.addEventListener('pagehide', () => { resetKeys(); observer.disconnect(); }, { once: true });
  return { center };
};
