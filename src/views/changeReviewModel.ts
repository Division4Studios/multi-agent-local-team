/** A human review packet from current tracked changes; AI explanations never replace recorded check results. */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { HunkStore, TrackedHunk } from '../review/hunkStore';
import { verdictOf } from '../review/reviewProgress';
import type { ArchitectureModule, Finding } from '../shared/protocol';
import { importCandidates, relativeImports } from '../reviewer/investigation';
import { redactSecrets } from '../reviewer/redact';
import { dialogueOf } from '../architecture/discussion';
import type { Turn } from '../architecture/discussion';

export interface ChangeBlock {
  readonly id: string;
  readonly line: number;
  readonly endLine: number;
  readonly status: string;
  readonly activity: string;
  readonly summary: string;
  readonly purpose: string;
  readonly design: string;
  readonly error: string;
  readonly checks: readonly { readonly title: string; readonly status: string; readonly note: string; readonly detail: string }[];
}
export interface ChangeFile {
  readonly path: string;
  readonly folder: string;
  readonly name: string;
  readonly added: number;
  readonly removed: number;
  readonly responsibility: string;
  readonly blocks: readonly ChangeBlock[];
}
export interface ChangedImport { readonly from: string; readonly to: string; readonly change: 'added' | 'removed' }
export interface ChangePacket {
  readonly revision: string;
  readonly files: readonly ChangeFile[];
  readonly imports: readonly ChangedImport[];
  readonly findings: readonly Finding[];
  readonly counts: { readonly blocks: number; readonly failed: number; readonly passed: number; readonly unfinished: number; readonly errors: number };
}

const blockOf = (tracked: TrackedHunk, store: HunkStore): ChangeBlock => {
  const state = store.state(tracked.id), review = state.review;
  return {
    id: tracked.id, line: tracked.hunk.startLine + 1, endLine: tracked.hunk.endLine + 1,
    status: review === undefined ? state.status : verdictOf(review) ?? state.status,
    activity: state.status,
    ...reviewDetails(review), error: state.error ?? '',
  };
};

const reviewDetails = (review: ReturnType<HunkStore['state']>['review']): Pick<ChangeBlock, 'summary' | 'purpose' | 'design' | 'checks'> => review === undefined
  ? { summary: 'This change has no reviewer explanation yet.', purpose: '', design: '', checks: [] }
  : { summary: review.overview.summary, purpose: review.overview.purpose, design: review.overview.design,
    checks: review.checks.map((check) => ({ title: check.title, status: check.status, note: check.note, detail: check.detail })) };

const changedImports = (tracked: TrackedHunk, marker: string, known: ReadonlySet<string>): ChangedImport[] => {
  const changed = tracked.hunk.body.split('\n').filter((line) => line.startsWith(marker)).map((line) => line.slice(1)).join('\n');
  return relativeImports(changed).flatMap((specifier) => {
    const to = importCandidates(tracked.relativePath, specifier).find((path) => known.has(path));
    return to === undefined ? [] : [{ from: tracked.relativePath, to, change: marker === '+' ? 'added' : 'removed' }];
  });
};

const importsOf = (hunks: readonly TrackedHunk[], modules: readonly ArchitectureModule[]): ChangedImport[] => {
  const known = new Set([...hunks.map((hunk) => hunk.relativePath), ...modules.map((module) => module.path)]);
  const edges = new Map<string, ChangedImport>();
  for (const tracked of hunks) {
    for (const marker of ['+', '-']) {
      for (const edge of changedImports(tracked, marker, known)) { edges.set(JSON.stringify([edge.from, edge.to, edge.change]), edge); }
    }
  }
  return [...edges.values()].filter((edge) => !edges.has(JSON.stringify([edge.from, edge.to, edge.change === 'added' ? 'removed' : 'added'])));
};

export const changePacket = (store: HunkStore, modules: readonly ArchitectureModule[], findings: readonly Finding[]): ChangePacket => {
  const files = store.allFiles().filter((hunks) => hunks.length > 0).map((hunks): ChangeFile => {
    const path = hunks[0]?.relativePath ?? '';
    const module = modules.find((candidate) => candidate.path === path);
    return {
      path, folder: posix.dirname(path), name: posix.basename(path), added: hunks.reduce((sum, hunk) => sum + hunk.hunk.added, 0),
      removed: hunks.reduce((sum, hunk) => sum + hunk.hunk.removed, 0), responsibility: module?.understanding?.what ?? module?.purpose ?? '',
      blocks: hunks.map((hunk) => blockOf(hunk, store)),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const blocks = files.flatMap((file) => file.blocks);
  const revision = createHash('sha256').update(JSON.stringify([store.allHunks().map((hunk) => [hunk.relativePath, hunk.hunk.body, hunk.hunk.startLine]), files, findings])).digest('hex');
  return { revision, files, imports: importsOf(store.allHunks(), modules), findings, counts: {
    blocks: blocks.length, failed: blocks.filter((block) => block.status === 'fail').length,
    passed: blocks.filter((block) => block.status === 'pass').length, errors: blocks.filter((block) => block.status === 'error').length,
    unfinished: blocks.filter((block) => !['pass', 'fail'].includes(block.status)).length,
  } };
};

/** Whole patches are kept or omitted. The model is explicitly told which source it did not receive. */
export const changeDiscussion = (store: HunkStore, packet: ChangePacket): { source: string; context: string; supplied: string[]; omitted: number } => {
  let source = '';
  const supplied = new Set<string>();
  let omitted = 0;
  for (const tracked of store.allHunks()) {
    const patch = redactSecrets(`Path: ${tracked.relativePath}\n${tracked.hunk.header}\n${tracked.hunk.body}\n\n`);
    if (source.length + patch.length > 46_000) { omitted++; continue; }
    source += patch;
    supplied.add(tracked.relativePath);
  }
  const context = JSON.stringify({
    scope: 'Saved uncommitted tracked changes. Patch excerpts, not complete implementations. Tests have NOT been executed by this panel. Recorded review results are AI checks, not test results. Business intent is inferred unless explicitly documented. Omitted evidence remains unknown.',
    counts: packet.counts, files: packet.files.slice(0, 35).map((file) => ({ path: file.path, responsibility: file.responsibility.slice(0, 300),
      blocks: file.blocks.slice(0, 8).map((block) => ({ line: block.line, summary: block.summary.slice(0, 180), purpose: block.purpose.slice(0, 180), status: block.status,
        failed: block.checks.filter((check) => check.status === 'fail').slice(0, 4).map((check) => ({ title: check.title, note: check.note.slice(0, 150) })) })) })),
    importChanges: packet.imports.slice(0, 30), consolidation: packet.findings.slice(0, 8).map((finding) => ({ title: finding.title, note: finding.note })),
    suppliedPatchFiles: [...supplied], omittedPatchBlocks: omitted,
  });
  return { source, context: boundedContext(context, packet, omitted), supplied: [...supplied], omitted };
};

const boundedContext = (context: string, packet: ChangePacket, omitted: number): string => {
  if (context.length <= 10_000) { return context; }
  const kept = packet.files.slice(0, 100).map((file) => file.path);
  const fallback = (): string => JSON.stringify({
    scope: 'Large change: only bounded patch evidence and aggregate review counts are available. No tests were run by this panel. Business intent is inferred. Architecture summaries and detailed review metadata were omitted to fit the budget.',
    counts: packet.counts, files: kept, omittedPatchBlocks: omitted,
  });
  while (fallback().length > 10_000) { kept.pop(); }
  return fallback();
};

/** A test result the developer recorded on the page. MALT did not run or check it. */
export interface Verification { readonly outcome: string; readonly note: string }

/**
 * The discussion dialogue: earlier turns, then the developer's recorded test result (their own words, so a developer
 * turn, never MALT-asserted context), then the question. `dialogueOf` keeps it valid, bounded JSON whose roles only
 * MALT sets, and drops the oldest turns first, so the result and the question are the last to go.
 */
export const changeDialogue = (history: readonly Turn[], verification: Verification | undefined, question: string): string => {
  const reported: Turn[] = verification === undefined ? [] : [{
    role: 'developer', text: `Developer-reported test result (not run or checked by MALT): ${verification.outcome}. ${verification.note}`,
  }];
  return dialogueOf([...history, ...reported, { role: 'developer', text: question }]);
};
