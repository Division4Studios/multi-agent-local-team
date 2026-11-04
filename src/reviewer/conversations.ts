/**
 * In-memory log of model calls for the live reviewer view. Never written to disk: a bounded backlog (so a newly
 * opened log shows recent calls) plus live subscribers. Streamed text is capped per call so a runaway answer cannot
 * grow memory without bound.
 */
import { randomBytes } from 'node:crypto';
import type { CallUsage, ConversationEvent } from '../shared/conversation';
import { describeError } from './log';
import { StreamRedactor, redactSecrets } from './redact';

const MAX_BACKLOG_EVENTS = 4_000;
const MAX_PROMPT_CHARS = 40_000;
const MAX_TEXT_CHARS_PER_CALL = 200_000;

export type ConversationListener = (event: ConversationEvent) => void;

/** Handle for one model call: stream text into it, then end it exactly once. */
export interface ConversationCall {
  readonly text: (chunk: string) => void;
  readonly end: (error?: unknown, usage?: CallUsage) => void;
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

  /**
   * Starts logging one call. Everything logged is secret-redacted first: the prompt and errors as a whole, the
   * streamed answer through a `StreamRedactor` (so a secret split across chunks is still caught).
   */
  public begin(label: string, profile: { readonly model: string; readonly effort: string }, prompt: string): ConversationCall {
    const callId = randomBytes(8).toString('hex');
    const redacted = redactSecrets(prompt);
    const shown = redacted.length > MAX_PROMPT_CHARS ? `${redacted.slice(0, MAX_PROMPT_CHARS)}\n… (prompt truncated for display)` : redacted;
    this.emit({ kind: 'start', callId, at: Date.now(), label, model: profile.model, effort: profile.effort, prompt: shown });
    const redactor = new StreamRedactor();
    let streamed = 0;
    let ended = false;
    const release = (text: string): void => {
      if (text === '' || streamed >= MAX_TEXT_CHARS_PER_CALL) {
        return;
      }
      const piece = text.slice(0, MAX_TEXT_CHARS_PER_CALL - streamed);
      streamed += piece.length;
      this.emit({ kind: 'text', callId, at: Date.now(), text: piece });
    };
    return {
      text: (chunk: string): void => {
        if (!ended) {
          release(redactor.push(chunk));
        }
      },
      end: (error?: unknown, usage?: CallUsage): void => {
        if (ended) {
          return;
        }
        ended = true;
        release(redactor.flush());
        const message = error === undefined ? '' : redactSecrets(describeError(error));
        this.emit({ kind: 'end', callId, at: Date.now(), ok: error === undefined, error: message, ...(usage === undefined ? {} : { usage }) });
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
