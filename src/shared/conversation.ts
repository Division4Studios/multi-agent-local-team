/**
 * Live reviewer conversation events, streamed from the reviewer to the extension's live log (GET /events).
 * Nothing is persisted: the reviewer keeps a short in-memory backlog so a newly opened log is not empty.
 * Every event crosses a trust boundary and is validated by `parseConversationEvent`.
 */
import { isNonNegativeInteger, isRecord, isString } from './guards';
import { isAgentId } from './reviewerAgents';

/** A model call started: what it is for, which model and effort, and the (untrusted) user prompt it was given. */
export interface ConversationStart {
  readonly agentId?: string;
  readonly kind: 'start';
  readonly callId: string;
  readonly at: number;
  readonly label: string;
  readonly model: string;
  readonly effort: string;
  readonly prompt: string;
}

/** Tokens and cost for one call, as the provider reported them (cost is notional on a subscription). */
export interface CallUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens served from the prompt cache (cheaper); included in neither count above. */
  readonly cachedTokens: number;
  readonly costUsd: number;
}

/** A piece of the model's answer as it streams in. */
export interface ConversationText {
  readonly agentId?: string;
  readonly kind: 'text';
  readonly callId: string;
  readonly at: number;
  readonly text: string;
}

/** The call finished, successfully or not, with its usage when the provider reported it. */
export interface ConversationEnd {
  readonly agentId?: string;
  readonly kind: 'end';
  readonly callId: string;
  readonly at: number;
  readonly ok: boolean;
  readonly error: string;
  readonly usage?: CallUsage;
}

export type ConversationEvent = ConversationStart | ConversationText | ConversationEnd;

const CALL_ID = /^[a-f0-9]{8,32}$/u;

const parseStart = (value: Readonly<Record<string, unknown>>, callId: string, at: number): ConversationStart | undefined => {
  const { label, model, effort, prompt } = value;
  return isString(label) && isString(model) && isString(effort) && isString(prompt)
    ? { kind: 'start', callId, at, label, model, effort, prompt }
    : undefined;
};

const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const parseCallUsage = (value: unknown): CallUsage | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { inputTokens, outputTokens, cachedTokens, costUsd } = value;
  return isNonNegativeInteger(inputTokens) && isNonNegativeInteger(outputTokens) && isNonNegativeInteger(cachedTokens) && isAmount(costUsd)
    ? { inputTokens, outputTokens, cachedTokens, costUsd }
    : undefined;
};

/** An end event whose usage is present but malformed is rejected, not silently stripped. */
const parseEnd = (value: Readonly<Record<string, unknown>>, callId: string, at: number): ConversationEnd | undefined => {
  const { ok, error } = value;
  if (typeof ok !== 'boolean' || !isString(error)) {
    return undefined;
  }
  if (value['usage'] === undefined) {
    return { kind: 'end', callId, at, ok, error };
  }
  const usage = parseCallUsage(value['usage']);
  return usage === undefined ? undefined : { kind: 'end', callId, at, ok, error, usage };
};

const parseEvent = (value: unknown): ConversationEvent | undefined => {
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

/** Agent metadata is optional for older log events, but malformed identities are rejected. */
export const parseConversationEvent = (value: unknown): ConversationEvent | undefined => {
  const event = parseEvent(value);
  if (event === undefined || !isRecord(value)) { return undefined; }
  const agentId = value['agentId'];
  if (agentId === undefined) { return event; }
  return isAgentId(agentId) ? { ...event, agentId } : undefined;
};
