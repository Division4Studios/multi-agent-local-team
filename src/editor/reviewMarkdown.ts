/**
 * Renders a block's review as a hover/tooltip card. Model output is untrusted: it is only ever added with
 * `appendText` (escaped), and the only enabled command link is MALT's own "Review again".
 */
import * as vscode from 'vscode';
import type { HunkState, TrackedHunk } from '../review/hunkStore';
import { RULE_RUN_ORDER, ruleRows } from '../review/reviewProgress';
import { ICONS, RUN_LABELS, statusLabel, visualFor } from './visuals';

const appendSection = (markdown: vscode.MarkdownString, title: string, text: string): void => {
  markdown.appendMarkdown(`\n\n**${title}** `);
  markdown.appendText(text);
};

/** Counts per standing, then each failing rule with its note. Full details live in the Changes view. */
const appendChecks = (markdown: vscode.MarkdownString, state: HunkState): void => {
  const rows = state.review === undefined ? [] : ruleRows(state.review, state.running);
  const counts = RULE_RUN_ORDER.flatMap((run) => {
    const count = rows.filter((row) => row.run === run).length;
    return count === 0 ? [] : [`${String(count)} ${RUN_LABELS[run]}`];
  });
  markdown.appendMarkdown(`\n\n---\n\n**Rules** · ${counts.join(' · ')}`);
  for (const row of rows.filter((candidate) => candidate.run === 'fail')) {
    markdown.appendMarkdown('\n\n$(error) **Fail** · ');
    markdown.appendText(`${row.rule.title} — ${row.check?.note ?? ''}`);
  }
};

export const buildReviewMarkdown = (tracked: TrackedHunk, state: HunkState): vscode.MarkdownString => {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.isTrusted = { enabledCommands: ['malt.reviewAgain'] };
  const visual = visualFor(state);
  const lines = `lines ${String(tracked.hunk.startLine + 1)}–${String(tracked.hunk.endLine + 1)}`;
  const review = state.review;

  markdown.appendMarkdown(`**MALT** · $(${ICONS[visual]}) `);
  markdown.appendText(state.status === 'error' ? `Review failed: ${state.error ?? 'unknown error'}` : statusLabel(state));
  if (review !== undefined) {
    markdown.appendMarkdown('\n\n');
    markdown.appendText(review.overview.summary);
    appendSection(markdown, 'Purpose', review.overview.purpose);
    appendSection(markdown, 'Technical', review.overview.technical);
    appendSection(markdown, 'Design', review.overview.design);
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
