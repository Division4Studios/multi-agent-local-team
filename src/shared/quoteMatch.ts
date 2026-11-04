/**
 * Locating a quoted excerpt in a file, whitespace-insensitively. One implementation is shared by evidence
 * grounding (is the quote really in the file?) and the editor (which lines to outline), so every quote MALT accepts
 * can also be found and shown: indentation, line wrapping and repeated spaces never matter, the characters do.
 */

export interface QuoteSpan {
  /** Zero-based first and last source line the quote covers. */
  readonly start: number;
  readonly end: number;
}

/** The text with each whitespace run collapsed to one space, and the source line of every character kept. */
const normalizeWithLines = (text: string): { readonly normalized: string; readonly lineOf: readonly number[] } => {
  let normalized = '';
  const lineOf: number[] = [];
  let line = 0;
  let pendingSpace = false;
  for (const character of text) {
    if (/\s/u.test(character)) {
      pendingSpace = normalized !== '';
      if (character === '\n') {
        line += 1;
      }
      continue;
    }
    if (pendingSpace) {
      normalized += ' ';
      lineOf.push(line);
      pendingSpace = false;
    }
    normalized += character;
    lineOf.push(line);
  }
  return { normalized, lineOf };
};

const collapse = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** Where `quote` occurs in `text` (first occurrence), ignoring whitespace differences; undefined if it does not. */
export const findQuoteSpan = (text: string, quote: string): QuoteSpan | undefined => {
  const wanted = collapse(quote);
  if (wanted === '') {
    return undefined;
  }
  const { normalized, lineOf } = normalizeWithLines(text);
  const at = normalized.indexOf(wanted);
  const start = lineOf[at];
  const end = lineOf[at + wanted.length - 1];
  return at < 0 || start === undefined || end === undefined ? undefined : { start, end };
};
