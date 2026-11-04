/**
 * In-memory log of model calls for the live reviewer view. Never written to disk: a bounded backlog (so a newly
 * opened log shows recent calls) plus live subscribers. Streamed text is capped per call so a runaway answer cannot
 * grow memory without bound.
 */
import { randomBytes } from 'node:crypto';
import type { ConversationEvent } from '../shared/conversation';
import { describeError } from './log';

const MAX_BACKLOG_EVENTS = 4_000;
const MAX_PROMPT_CHARS = 40_000;
const MAX_TEXT_CHARS_PER_CALL = 200_000;

export type ConversationListener = (event: ConversationEvent) => void;

/** Handle for one model call: stream text into it, then end it exactly once. */
export interface ConversationCall {
  readonly text: (chunk: string) => void;
  readonly end: (error?: unknown) => void;
}

export class ConversationLog {
  private readonly backlog: ConversationEvent[] = [];
  private readonly listeners = new Set<ConversationListener>();

  /** Recent events, oldest first, for a subscriber that just connected. */
  public recent(): readonly ConversationEvent[] {
    return [...this.backlog];
  }

  public subscribe(listener: ConversationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public begin(label: string, model: string, prompt: string): ConversationCall {
    const callId = randomBytes(8).toString('hex');
    const truncated = prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}\n… (prompt truncated for display)` : prompt;
    this.emit({ kind: 'start', callId, at: Date.now(), label, model, prompt: truncated });
    let streamed = 0;
    let ended = false;
    return {
      text: (chunk: string): void => {
        if (ended || streamed >= MAX_TEXT_CHARS_PER_CALL || chunk === '') {
          return;
        }
        const piece = chunk.slice(0, MAX_TEXT_CHARS_PER_CALL - streamed);
        streamed += piece.length;
        this.emit({ kind: 'text', callId, at: Date.now(), text: piece });
      },
      end: (error?: unknown): void => {
        if (ended) {
          return;
        }
        ended = true;
        this.emit({ kind: 'end', callId, at: Date.now(), ok: error === undefined, error: error === undefined ? '' : describeError(error) });
      },
    };
  }

  private emit(event: ConversationEvent): void {
    this.backlog.push(event);
    if (this.backlog.length > MAX_BACKLOG_EVENTS) {
      this.backlog.splice(0, this.backlog.length - MAX_BACKLOG_EVENTS);
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
