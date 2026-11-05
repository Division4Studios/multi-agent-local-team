/**
 * Full-page view of one result: a rule check for a block, a consolidation finding, or the standards gaps.
 * Model output is untrusted: every value is HTML-escaped, scripts are disabled and the CSP allows only the page's
 * own nonce-tagged style.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { HunkStore } from '../review/hunkStore';
import type { Finding } from '../shared/protocol';
import { isNonNegativeInteger, isString } from '../shared/guards';
import { RUN_LABELS } from '../editor/visuals';
import { findingSections } from '../shared/findingText';
import { findingLinks } from '../editor/findingMarkdown';
import type { FindingLinks } from '../editor/findingMarkdown';
import { workspaceFile } from '../editor/findingHighlight';

interface Section {
  readonly title: string;
  readonly text: string;
}

interface DetailPage {
  readonly title: string;
  readonly status: { readonly label: string; readonly className: string };
  readonly meta: readonly string[];
  readonly sections: readonly Section[];
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const escapeHtml = (text: string): string => text.replace(/[&<>"']/gu, (character) => ESCAPES[character] ?? '');

const STYLE = `
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background);
  max-width: 52rem; margin: 0 auto; padding: 1.5rem; line-height: 1.55; }
h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
h2 { font-size: 1.05rem; margin-top: 2rem; padding-bottom: 0.3rem; border-bottom: 1px solid var(--vscode-panel-border); }
h3 { font-size: 0.95rem; margin: 0 0 0.25rem; }
p { white-space: pre-wrap; margin: 0.25rem 0; }
.meta, .muted { color: var(--vscode-descriptionForeground); }
.status { font-weight: 600; text-transform: uppercase; }
.fail { color: var(--vscode-errorForeground); }
.pass { color: var(--vscode-testing-iconPassed); }
nav ul { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 0.4rem 1rem; }
nav a, a { color: var(--vscode-textLink-foreground); text-decoration: none; }
.card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 0.7rem 0.9rem; margin: 0.6rem 0; }
.tags { margin-top: 0.4rem; display: flex; flex-wrap: wrap; gap: 0.35rem; }
.tag { font-size: 0.8em; padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground); }
code { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }
pre.code { white-space: pre-wrap; word-break: break-word; margin: 0.5rem 0 0; padding: 0.5rem 0.65rem; border-radius: 4px;
  background: var(--vscode-textCodeBlock-background); }
.verdict { display: inline-block; font-weight: 600; padding: 0.1rem 0.55rem; border-radius: 999px; }`;

const renderPage = (page: DetailPage, nonce: string): string => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">${STYLE}</style><title>${escapeHtml(page.title)}</title></head><body>
<h1>${escapeHtml(page.title)}</h1>
<p class="meta"><span class="status ${page.status.className}">${escapeHtml(page.status.label)}</span>${page.meta.map((item) => ` · ${escapeHtml(item)}`).join('')}</p>
${page.sections.map((section) => `<h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.text)}</p>`).join('\n')}
</body></html>`;

let panel: vscode.WebviewPanel | undefined;

const showHtml = (title: string, html: string): void => {
  if (panel === undefined) {
    panel = vscode.window.createWebviewPanel('malt.detail', '', vscode.ViewColumn.Beside, { enableScripts: false, enableCommandUris: ['malt.openFindingReference'] });
    panel.onDidDispose(() => {
      panel = undefined;
    });
  }
  panel.title = `MALT · ${title}`;
  panel.webview.html = html;
  panel.reveal(vscode.ViewColumn.Beside, true);
};

const showPage = (page: DetailPage): void => {
  showHtml(page.title, renderPage(page, randomBytes(16).toString('hex')));
};

/** One card on a list page. `code` (optional) is shown as a monospace block, escaped like everything else. */
export interface ListItem {
  readonly title: string;
  readonly body: readonly string[];
  readonly tags: readonly string[];
  readonly code?: string;
}

/** A document-style page: groups of cards with a table of contents. Every value is escaped when rendered. */
export interface ListPage {
  readonly title: string;
  readonly meta: readonly string[];
  readonly empty: string;
  readonly groups: readonly { readonly heading: string; readonly items: readonly ListItem[] }[];
}

const renderItem = (item: ListItem): string =>
  `<div class="card"><h3>${escapeHtml(item.title)}</h3>${item.body.map((text) => `<p>${escapeHtml(text)}</p>`).join('')}${
    item.code === undefined ? '' : `<pre class="code"><code>${escapeHtml(item.code)}</code></pre>`
  }${item.tags.length === 0 ? '' : `<div class="tags">${item.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>`}</div>`;

const renderListPage = (page: ListPage, nonce: string): string => {
  const toc = page.groups.map((group, index) => `<li><a href="#g${String(index)}">${escapeHtml(group.heading)} <span class="muted">(${String(group.items.length)})</span></a></li>`);
  const body = page.groups.length === 0
    ? `<p class="muted">${escapeHtml(page.empty)}</p>`
    : `<nav><ul>${toc.join('')}</ul></nav>${page.groups
      .map((group, index) => `<h2 id="g${String(index)}">${escapeHtml(group.heading)}</h2>${group.items.map(renderItem).join('')}`)
      .join('\n')}`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">${STYLE}</style><title>${escapeHtml(page.title)}</title></head><body>
<h1>${escapeHtml(page.title)}</h1><p class="meta">${page.meta.map(escapeHtml).join(' · ')}</p>${body}</body></html>`;
};

export const showListPage = (page: ListPage): void => {
  showHtml(page.title, renderListPage(page, randomBytes(16).toString('hex')));
};

/** Resolves the arguments against the store; never trusts caller-supplied review content. */
const rulePage = (store: HunkStore, id: unknown, startLine: unknown, ruleId: unknown): DetailPage | undefined => {
  if (!isString(id) || !isNonNegativeInteger(startLine) || !isString(ruleId)) {
    return undefined;
  }
  const tracked = store.get(id, startLine);
  const review = store.state(id).review;
  const rule = review?.rules.find((candidate) => candidate.id === ruleId);
  const check = review?.checks.find((candidate) => candidate.ruleId === ruleId);
  if (tracked === undefined || review === undefined || rule === undefined || check === undefined) {
    return undefined;
  }
  const { overview } = review;
  return {
    title: rule.title,
    status: { label: RUN_LABELS[check.status], className: check.status },
    meta: [`${tracked.relativePath}, lines ${String(tracked.hunk.startLine + 1)}–${String(tracked.hunk.endLine + 1)}`, rule.category, rule.source],
    sections: [
      { title: 'Rule', text: rule.check },
      { title: 'Result', text: check.note },
      { title: 'Details', text: check.detail },
      { title: 'Purpose of this change', text: overview.purpose },
      { title: 'Technical', text: overview.technical },
      { title: 'Design', text: overview.design },
    ],
  };
};

export const showRuleCheck = (store: HunkStore, id: unknown, startLine: unknown, ruleId: unknown): void => {
  const page = rulePage(store, id, startLine, ruleId);
  if (page !== undefined) {
    showPage(page);
  }
};

/** All gaps from a standards scan on one page. */
const referenceHtml = (label: string, uri: vscode.Uri): string => {
  const command = `command:malt.openFindingReference?${encodeURIComponent(JSON.stringify([uri.toString()]))}`;
  return `<a href="${escapeHtml(command)}">${escapeHtml(label)}</a>`;
};
const gapInline = (text: string, links: FindingLinks): string => text.split('`').map((part, index) => {
  if (index % 2 === 0) { return escapeHtml(part); }
  const uri = links.get(part);
  return uri === undefined ? `<code>${escapeHtml(part)}</code>` : referenceHtml(part, uri);
}).join('');

export const showGaps = async (gaps: readonly Finding[], folder?: vscode.WorkspaceFolder): Promise<void> => {
  const cards = await Promise.all(gaps.map(async (gap) => {
    const links = folder === undefined ? new Map<string, vscode.Uri>() : await findingLinks(gap, async (path) => await workspaceFile(folder, path));
    const sections = findingSections(gap.detail).map((section) => `<h3>${escapeHtml(section.title)}</h3><ul>${section.lines.map((line) => `<li>${gapInline(line, links)}</li>`).join('')}</ul>`);
    const references = gap.files.map((file) => { const uri = links.get(file); return `<li>${uri === undefined ? escapeHtml(file) : referenceHtml(file, uri)}</li>`; });
    return `<article class="card"><h2>${escapeHtml(gap.title)}</h2><p>${escapeHtml(gap.note)}</p>${sections.join('')}<details><summary>References (${String(references.length)})</summary><ul>${references.join('')}</ul></details></article>`;
  }));
  const nonce = randomBytes(16).toString('hex');
  showHtml('Standards gaps', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';"><style nonce="${nonce}">${STYLE}
.card { padding: 1.25rem; margin: 1rem 0; overflow-wrap: anywhere; } .card h2 { margin: 0 0 .75rem; border: 0; } .card h3 { margin-top: 1.25rem; }
li { margin: .5rem 0; overflow-wrap: anywhere; } summary { cursor: pointer; margin-top: 1rem; } a:focus-visible { outline: 2px solid var(--vscode-focusBorder); }
</style><title>Standards gaps</title></head><body><h1>Standards gaps</h1><p class="meta">${String(gaps.length)} questions for the team · Findings from the last scan</p>${cards.join('')}</body></html>`);
};

/** `index` comes from a tree node; it is checked against the current findings. */
export const showFinding = (findings: readonly Finding[], index: unknown): void => {
  const finding = isNonNegativeInteger(index) ? findings[index] : undefined;
  if (finding !== undefined) {
    showPage({
      title: finding.title,
      status: { label: 'Consolidate', className: 'fail' },
      meta: finding.files,
      sections: [
        { title: 'Finding', text: finding.note },
        { title: 'Details', text: finding.detail },
      ],
    });
  }
};
