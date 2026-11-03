/**
 * Splits changes into reviewable blocks. Pure functions, no VS Code dependency.
 * - Tracked files: each git hunk is one block; its outline spans the first to last changed line.
 * - New (untracked) files: split into paragraph-sized blocks at blank lines.
 */
import { createHash } from 'node:crypto';

export interface DiffHunk {
  /** Hunk header, e.g. `@@ -10,3 +10,5 @@ function name`. */
  readonly header: string;
  /** Hunk body lines (` `, `+`, `-` prefixed), without the header. */
  readonly body: string;
  /** Zero-based, inclusive range of changed lines in the current file. */
  readonly startLine: number;
  readonly endLine: number;
  readonly added: number;
  readonly removed: number;
}

interface HunkBuilder {
  readonly header: string;
  readonly lines: string[];
  nextLine: number;
  first: number | undefined;
  last: number | undefined;
  added: number;
  removed: number;
}

const HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

const markChanged = (builder: HunkBuilder, line: number): void => {
  builder.first ??= line;
  builder.last = line;
};

const consume = (builder: HunkBuilder, line: string): void => {
  const marker = line.charAt(0);
  if (marker === '+') {
    markChanged(builder, builder.nextLine);
    builder.nextLine += 1;
    builder.added += 1;
  } else if (marker === '-') {
    markChanged(builder, builder.nextLine);
    builder.removed += 1;
  } else if (marker === ' ') {
    builder.nextLine += 1;
  } else if (marker !== '\\') {
    return;
  }
  builder.lines.push(line);
};

const finish = (builder: HunkBuilder): DiffHunk => {
  const startLine = builder.first ?? builder.nextLine;
  return {
    header: builder.header,
    body: builder.lines.join('\n'),
    startLine,
    endLine: Math.max(startLine, builder.last ?? startLine),
    added: builder.added,
    removed: builder.removed,
  };
};

export const parseUnifiedDiff = (patch: string): DiffHunk[] => {
  const hunks: DiffHunk[] = [];
  let current: HunkBuilder | undefined;
  for (const line of patch.split(/\r?\n/u)) {
    const match = HEADER.exec(line);
    if (match !== null) {
      if (current !== undefined) {
        hunks.push(finish(current));
      }
      const newStart = Number(match[1]);
      current = { header: line, lines: [], nextLine: Math.max(0, newStart - 1), first: undefined, last: undefined, added: 0, removed: 0 };
    } else if (current !== undefined) {
      consume(current, line);
    }
  }
  if (current !== undefined) {
    hunks.push(finish(current));
  }
  return hunks.filter((hunk) => hunk.added + hunk.removed > 0);
};

const MIN_BLOCK_LINES = 30;
const MAX_BLOCK_LINES = 80;

const toAddedHunk = (lines: readonly string[], start: number): DiffHunk => ({
  header: `@@ -0,0 +${String(start + 1)},${String(lines.length)} @@ (new file)`,
  body: lines.map((line) => `+${line}`).join('\n'),
  startLine: start,
  endLine: start + lines.length - 1,
  added: lines.length,
  removed: 0,
});

/** Splits a new file into blocks, preferring to break at blank lines once a block reaches MIN_BLOCK_LINES. */
export const newFileHunks = (content: string): DiffHunk[] => {
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  const hunks: DiffHunk[] = [];
  let start = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const size = index - start + 1;
    const atParagraphBreak = size >= MIN_BLOCK_LINES && lines[index]?.trim() === '';
    if (atParagraphBreak || size >= MAX_BLOCK_LINES || index === lines.length - 1) {
      hunks.push(toAddedHunk(lines.slice(start, index + 1), start));
      start = index + 1;
    }
  }
  return hunks;
};

/** Stable id for a block: independent of line numbers, so earlier edits that shift it keep its review. */
export const hunkId = (relativePath: string, hunk: DiffHunk): string =>
  createHash('sha256').update(relativePath).update('\0').update(hunk.body).digest('hex').slice(0, 20);
