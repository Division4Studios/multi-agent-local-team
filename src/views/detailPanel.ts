/**
 * Full-page view of one result, opened from the Changes view: a rule check for a block, or a consolidation finding.
 * Model output is untrusted: every value is HTML-escaped, scripts are disabled and the CSP allows only the page's
 * own nonce-tagged style.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { HunkStore } from '../review/hunkStore';
import type { ConsolidationFinding } from '../shared/protocol';
import { isNonNegativeInteger, isString } from '../shared/guards';
import { RUN_LABELS } from '../editor/visuals';

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
h2 { font-size: 1rem; margin-top: 1.75rem; }
p { white-space: pre-wrap; }
.meta { color: var(--vscode-descriptionForeground); }
.status { font-weight: 600; text-transform: uppercase; }
.fail { color: var(--vscode-errorForeground); }
.pass { color: var(--vscode-testing-iconPassed); }`;

const renderPage = (page: DetailPage, nonce: string): string => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">${STYLE}</style><title>${escapeHtml(page.title)}</title></head><body>
<h1>${escapeHtml(page.title)}</h1>
<p class="meta"><span class="status ${page.status.className}">${escapeHtml(page.status.label)}</span>${page.meta.map((item) => ` · ${escapeHtml(item)}`).join('')}</p>
${page.sections.map((section) => `<h2>${escapeHtml(section.title)}</h2><p>${escapeHtml(section.text)}</p>`).join('\n')}
</body></html>`;

let panel: vscode.WebviewPanel | undefined;

const showPage = (page: DetailPage): void => {
  if (panel === undefined) {
    panel = vscode.window.createWebviewPanel('malt.detail', '', vscode.ViewColumn.Beside, { enableScripts: false });
    panel.onDidDispose(() => {
      panel = undefined;
    });
  }
  panel.title = `MALT · ${page.title}`;
  panel.webview.html = renderPage(page, randomBytes(16).toString('hex'));
  panel.reveal(vscode.ViewColumn.Beside, true);
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

/** `index` comes from a tree node; it is checked against the current findings. */
export const showFinding = (findings: readonly ConsolidationFinding[], index: unknown): void => {
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
