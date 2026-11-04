/**
 * Splits a byte stream into text lines. Uses a streaming UTF-8 decoder, so a multi-byte character split across
 * chunks is decoded intact (decoding each chunk on its own would turn it into replacement characters), and keeps
 * a partial last line until the rest arrives. A line that grows past `maxLineChars` triggers `onOverflow` and is
 * dropped, so a stream without newlines cannot grow memory without bound.
 */
import { StringDecoder } from 'node:string_decoder';

export interface LineSplitter {
  /** Adds bytes; calls `onLine` for every complete line (without its line ending). */
  readonly push: (chunk: Buffer) => void;
  /** Ends the stream; emits a final unterminated line, if any. */
  readonly end: () => void;
}

export interface LineSplitterOptions {
  readonly maxLineChars?: number;
  readonly onOverflow?: () => void;
}

const DEFAULT_MAX_LINE_CHARS = 10_000_000;

export const createLineSplitter = (onLine: (line: string) => void, options: LineSplitterOptions = {}): LineSplitter => {
  const decoder = new StringDecoder('utf8');
  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  let pending = '';
  const emitLines = (text: string): void => {
    const lines = (pending + text).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    if (pending.length > maxLineChars) {
      pending = '';
      options.onOverflow?.();
    }
  };
  return {
    push: (chunk: Buffer): void => {
      emitLines(decoder.write(chunk));
    },
    end: (): void => {
      emitLines(decoder.end());
      if (pending !== '') {
        const last = pending;
        pending = '';
        onLine(last.endsWith('\r') ? last.slice(0, -1) : last);
      }
    },
  };
};
