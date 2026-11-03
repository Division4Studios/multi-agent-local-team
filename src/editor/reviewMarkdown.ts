/**
 * Renders a block's review as a hover/tooltip card. Model output is untrusted: it is only ever added with
 * `appendText` (escaped), and the only enabled command link is MALT's own "Review again".
 */
import * as vscode from 'vscode';
import type { HunkState, TrackedHunk } from '../review/hunkStore';
import type { CheckStatus } from '../shared/protocol';
import { ICONS, VERDICT_LABELS, statusLabel, visualFor } from './visuals';

const CHECK_ICONS: Readonly<Record<CheckStatus, string>> = { pass: '$(pass)', fail: '$(error)', 'not-applicable': '$(dash)' };

const appendSection = (markdown: vscode.MarkdownString, title: string, text: string): void => {
  markdown.appendMarkdown(`\n\n**${title}** `);
  markdown.appendText(text);
};

const appendChecks = (markdown: vscode.MarkdownString, state: HunkState): void => {
  const checks = state.review?.checks ?? [];
  const relevant = checks.filter((check) => check.status !== 'not-applicable');
  markdown.appendMarkdown('\n\n---\n\n**Checks**');
  for (const check of relevant) {
    markdown.appendMarkdown(`\n\n${CHECK_ICONS[check.status]} **${check.status === 'pass' ? 'Pass' : 'Fail'}** · `);
    markdown.appendText(`${check.title} — ${check.note}`);
  }
  const skipped = checks.length - relevant.length;
  if (skipped > 0) {
    markdown.appendMarkdown(`\n\n${CHECK_ICONS['not-applicable']} ${String(skipped)} rule(s) not applicable`);
  }
};

export const buildReviewMarkdown = (tracked: TrackedHunk, state: HunkState): vscode.MarkdownString => {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = { enabledCommands: ['malt.reviewAgain'] };
  const visual = visualFor(state);
  const lines = `lines ${String(tracked.hunk.startLine + 1)}–${String(tracked.hunk.endLine + 1)}`;
  const review = state.review;

  if (review === undefined) {
    markdown.appendMarkdown(`**MALT** · $(${ICONS[visual]}) `);
    markdown.appendText(state.status === 'error' ? `Review failed: ${state.error ?? 'unknown error'}` : statusLabel(state));
  } else {
    markdown.appendMarkdown(`**MALT** · $(${ICONS[visual]}) **${VERDICT_LABELS[review.verdict]}**\n\n`);
    markdown.appendText(review.summary);
    appendSection(markdown, 'What', review.what);
    appendSection(markdown, 'Why', review.why);
    appendSection(markdown, 'Needed?', review.necessity);
    appendChecks(markdown, state);
  }

  const args = encodeURIComponent(JSON.stringify([tracked.id]));
  markdown.appendMarkdown(`\n\n---\n\n[Review again](command:malt.reviewAgain?${args}) · ${lines} · +${String(tracked.hunk.added)} −${String(tracked.hunk.removed)}`);
  return markdown;
};

interface HunkLookup {
  find: (uri: vscode.Uri, line: number) => TrackedHunk | undefined;
  state: (id: string) => HunkState;
}

export class ReviewHoverProvider implements vscode.HoverProvider {
  private readonly store: HunkLookup;

  public constructor(store: HunkLookup) {
    this.store = store;
  }

  public provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const tracked = this.store.find(document.uri, position.line);
    if (tracked === undefined) {
      return undefined;
    }
    const range = new vscode.Range(tracked.hunk.startLine, 0, tracked.hunk.endLine, Number.MAX_SAFE_INTEGER);
    return new vscode.Hover(buildReviewMarkdown(tracked, this.store.state(tracked.id)), range);
  }
}
