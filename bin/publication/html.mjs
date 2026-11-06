import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { renderDiagram, escape } from './geometry.mjs';
const asset = (name) => readFileSync(new URL('../../media/' + name, import.meta.url), 'utf8');
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const label = (k) => '<span data-label="' + k + '">' + k + '</span>';
const button = (id, k) => '<button id="' + id + '">' + label(k) + '</button>';
const select = (id, k, values) =>
  '<label>' + label(k) + ' <select id="' + id + '">' + values.map((v) => '<option>' + v + '</option>').join('') + '</select></label>';
const checkbox = (id, k) => '<label><input type="checkbox" checked id="' + id + '"> ' + label(k) + '</label>';
const style = asset('maltTheme.css') + '\n' + asset('perspectives.css') + '\n' + asset('portable.css') + '\n' + asset('diagramViewport.css');
const script = ['diagramViewport.js', 'perspectiveDrawing.js', 'portableLanguages.js', 'portableExport.js', 'portableProbe.js', 'portableViewer.js']
  .map(asset)
  .join('\n;\n');
const token = (text) => "'sha256-" + createHash('sha256').update(text).digest('base64') + "'";
const policy =
  "default-src 'none'; script-src " +
  token(script) +
  '; style-src ' +
  token(style) +
  "; img-src blob: data:; media-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'";
function citations(model) {
  const sources = model.answer?.panels ?? model.diagrams.flatMap((d) => d.items);
  const links = new Map();
  for (const item of sources) {
    const source = item.source,
      repo = source?.repository ?? model.meta?.repository;
    if (!source || !repo) continue;
    const key = JSON.stringify([repo.url, repo.revision, source.path, source.line ?? 0]);
    if (links.has(key)) continue;
    // The model validator allows only HTTPS repository roots and full commit IDs.
    const host = new URL(repo.url);
    const providerPath = host.hostname === 'gitlab.com' ? '/-/blob/' : '/blob/';
    host.pathname += providerPath + repo.revision + '/' + source.path.split('/').map(encodeURIComponent).join('/');
    if (source.line) host.hash = 'L' + source.line;
    links.set(
      key,
      '<a rel="noopener noreferrer" data-source="' +
        escape(key) +
        '" href="' +
        escape(host.href) +
        '">' +
        escape(source.path + (source.line ? ' · ' + source.line : '')) +
        '</a>',
    );
  }
  return '<template id="citations">' + [...links.values()].join('') + '</template>';
}
export function render(model, sourceHash) {
  const results = (model.diagrams || []).map((d) => renderDiagram(d));
  const title = model.answer?.title ?? model.diagrams[0].title;
  const json = JSON.stringify(model).replace(/</gu, '\\u003c');
  const article = (model.answer?.panels || [])
    .map((p) => '<article><h2>' + escape(p.title) + '</h2><p>' + escape(p.body) + '</p></article>')
    .join('');
  const toolbar =
    select('view', 'view', []) +
    select('part', 'part', []) +
    button('parent', 'parent') +
    '<input id="find" type="search" aria-label="Find component">';
  const reader = select('theme', 'theme', ['auto', 'light', 'dark']) + select('language', 'language', []);
  const options =
    checkbox('motion', 'motion') +
    checkbox('fields', 'fields') +
    select('zone', 'zone', ['UTC', 'local']) +
    select('zoom', 'scale', ['1', '0.75', '1.25', '1.5', '2']) + button('center', 'center');
  const exports =
    select('format', 'formats', ['svg', 'png', 'jpeg', 'webp', 'webm', 'clipboard']) +
    select('scale', 'scale', ['1', '2', '3', '4']) +
    button('save', 'save');
  const navigation =
    select('journey', 'journey', []) +
    button('prev', 'previous') +
    button('play', 'play') +
    button('pause', 'pause') +
    button('next', 'next');
  const html =
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="' +
    escape(policy) +
    '"><meta name="malt-source-sha256" content="' +
    sourceHash +
    '"><title>' +
    escape(title) +
    '</title>' +
    '<style id="drawing-style">' +
    style +
    '</style></head><body><header><small>MALT / ' +
    (model.answer ? 'BRIEF' : 'ARCHITECTURE ATLAS') +
    '</small><h1 id="title">' +
    escape(title) +
    '</h1><nav>' +
    reader +
    '</nav></header>' +
    '<main><section id="diagram"' +
    (model.answer ? ' hidden' : '') +
    '><nav>' +
    toolbar +
    '</nav><div class="toolbar">' +
    options +
    '</div><p id="navigationHint">' + label('panHint') + '</p><div id="modelDrawing" data-diagram-viewport tabindex="0" role="region" aria-label="Diagram canvas" aria-describedby="navigationHint">' +
    (results[0]?.markup ?? '<svg id="modelSvg"></svg>') +
    '</div><aside id="legend" aria-label="Roles"></aside><details open><summary>' +
    label('journey') +
    '</summary><div class="toolbar">' +
    navigation +
    '</div><ol id="routes"></ol></details>' +
    '<details><summary>' +
    label('export') +
    '</summary><div class="toolbar">' +
    exports +
    '</div></details></section><section id="answers"><noscript>' +
    article +
    '</noscript></section>' +
    '<aside id="detail" aria-live="polite"></aside>' +
    button('ask', 'ask') +
    '<textarea id="prompt" hidden readonly aria-label="Panel follow-up"></textarea><p role="status" id="status"></p></main>' +
    citations(model) +
    '<script id="malt-source" type="application/json">' +
    json +
    '</script><script>' +
    script +
    '</script></body></html>\n';
  return { html, layout: results.map((r) => r.geometry) };
}
