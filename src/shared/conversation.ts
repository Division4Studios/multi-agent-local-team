/**
 * Live reviewer conversation events, streamed from the reviewer to the extension's live log (GET /events).
 * Nothing is persisted: the reviewer keeps a short in-memory backlog so a newly opened log is not empty.
 * Every event crosses a trust boundary and is validated by `parseConversationEvent`.
 */
import { isNonNegativeInteger, isRecord, isString } from './guards';

/** A model call started: what it is for, which model, and the (untrusted) user prompt it was given. */
export interface ConversationStart {
  readonly kind: 'start';
  readonly callId: string;
  readonly at: number;
  readonly label: string;
  readonly model: string;
  readonly prompt: string;
}

/** A piece of the model's answer as it streams in. */
export interface ConversationText {
  readonly kind: 'text';
  readonly callId: string;
  readonly at: number;
  readonly text: string;
}

/** The call finished, successfully or not. */
export interface ConversationEnd {
  readonly kind: 'end';
  readonly callId: string;
  readonly at: number;
  readonly ok: boolean;
  readonly error: string;
}

export type ConversationEvent = ConversationStart | ConversationText | ConversationEnd;

const CALL_ID = /^[a-f0-9]{8,32}$/u;

const parseStart = (value: Readonly<Record<string, unknown>>, callId: string, at: number): ConversationStart | undefined => {
  const { label, model, prompt } = value;
  return isString(label) && isString(model) && isString(prompt) ? { kind: 'start', callId, at, label, model, prompt } : undefined;
};

const parseEnd = (value: Readonly<Record<string, unknown>>, callId: string, at: number): ConversationEnd | undefined => {
  const { ok, error } = value;
  return typeof ok === 'boolean' && isString(error) ? { kind: 'end', callId, at, ok, error } : undefined;
};

export const parseConversationEvent = (value: unknown): ConversationEvent | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { kind, callId, at, text } = value;
  if (!isString(callId) || !CALL_ID.test(callId) || !isNonNegativeInteger(at)) {
    return undefined;
  }
  switch (kind) {
    case 'start':
      return parseStart(value, callId, at);
    case 'text':
      return isString(text) ? { kind: 'text', callId, at, text } : undefined;
    case 'end':
      return parseEnd(value, callId, at);
    default:
      return undefined;
  }
};
