/**
 * Full-page view of one rule's result for one block, opened from the Changes view. Model output is untrusted:
 * every value is HTML-escaped, scripts are disabled and the CSP allows only the page's own nonce-tagged style.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { HunkStore, TrackedHunk } from '../review/hunkStore';
import type { BlockOverview, Rule, RuleCheck } from '../shared/protocol';
import { isNonNegativeInteger, isString } from '../shared/guards';
import { RUN_LABELS } from '../editor/visuals';

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const escapeHtml = (text: string): string => text.replace(/[&<>"']/gu, (character) => ESCAPES[character] ?? '');

const section = (title: string, text: string): string => `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p>`;

interface Page {
  readonly tracked: TrackedHunk;
  readonly rule: Rule;
  readonly check: RuleCheck;
  readonly overview: BlockOverview;
}

const STYLE = `
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background);
  max-width: 52rem; margin: 0 auto; padding: 1.5rem; line-height: 1.55; }
h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
h2 { font-size: 1rem; margin-top: 1.75rem; }
p { white-space: pre-wrap; }
.meta { color: var(--vscode-descriptionForeground); }
.status { font-weight: 600; text-transform: uppercase; }
.fail { color: var(--vscode-errorForeground); }
.pass { color: var(--vscode-testing-iconPassed); }
hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin-top: 2rem; }`;

const renderPage = ({ tracked, rule, check, overview }: Page, nonce: string): string => {
  const lines = `${tracked.relativePath}, lines ${String(tracked.hunk.startLine + 1)}–${String(tracked.hunk.endLine + 1)}`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">${STYLE}</style><title>${escapeHtml(rule.title)}</title></head><body>
<h1>${escapeHtml(rule.title)}</h1>
<p class="meta"><span class="status ${check.status}">${escapeHtml(RUN_LABELS[check.status])}</span> · ${escapeHtml(lines)} · ${escapeHtml(rule.category)} · ${escapeHtml(rule.source)}</p>
${section('Rule', rule.check)}
${section('Result', check.note)}
${section('Details', check.detail)}
<hr>
${section('Purpose of this change', overview.purpose)}
${section('Technical', overview.technical)}
${section('Design', overview.design)}
</body></html>`;
};

let panel: vscode.WebviewPanel | undefined;

/** Resolves the arguments against the store; never trusts caller-supplied review content. */
const findPage = (store: HunkStore, id: unknown, startLine: unknown, ruleId: unknown): Page | undefined => {
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
  return { tracked, rule, check, overview: review.overview };
};

export const showRuleCheck = (store: HunkStore, id: unknown, startLine: unknown, ruleId: unknown): void => {
  const page = findPage(store, id, startLine, ruleId);
  if (page === undefined) {
    return;
  }
  if (panel === undefined) {
    panel = vscode.window.createWebviewPanel('malt.ruleCheck', '', vscode.ViewColumn.Beside, { enableScripts: false });
    panel.onDidDispose(() => {
      panel = undefined;
    });
  }
  panel.title = `MALT · ${page.rule.title}`;
  panel.webview.html = renderPage(page, randomBytes(16).toString('hex'));
  panel.reveal(vscode.ViewColumn.Beside, true);
};
