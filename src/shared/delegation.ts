/**
 * Delegated model calls: calls for a provider that only the extension can reach (GitHub Copilot, through VS Code's
 * Language Model API; Codex, in a container the extension starts). The reviewer still builds every prompt and validates every answer; the extension only runs
 * the call. Both directions cross the HTTP boundary, so both are parsed and bounded here.
 */
import { isRecord, isString, parseArray } from './guards';
import { isEffort, isModelName, isProviderId } from './reviewProfiles';
import type { Effort, ProviderId } from './reviewProfiles';

export interface DelegatedCall {
  readonly id: string;
  readonly provider: ProviderId;
  readonly model: string;
  /** Reasoning effort, for providers that take one (Codex); `default` leaves the provider's own. */
  readonly effort: Effort;
  /** MALT's static system prompt: never repository text. */
  readonly systemPrompt: string;
  /** Repository text appears only inside nonced data blocks, as in every reviewer prompt. */
  readonly userPrompt: string;
  /** The JSON Schema the answer must satisfy; the reviewer's parsers check it again. */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

/** The answer to one delegated call: its JSON output, or why it failed. Never both. */
export type DelegatedResult =
  | { readonly id: string; readonly output: unknown }
  | { readonly id: string; readonly error: string };

/** Answer text as it streams in, for the live log and stall detection; display only. */
export interface DelegatedText {
  readonly id: string;
  readonly text: string;
}

/**
 * The largest answer the extension posts back, serialized. The reviewer accepts request bodies up to 1,000,000 bytes,
 * so this leaves room for the envelope; a larger answer is reported as an error instead of being sent.
 */
export const MAX_DELEGATED_RESULT_BYTES = 900_000;

const ID = /^[a-f0-9-]{36}$/u;
export const isDelegationId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

const MAX_PROMPT_CHARS = 2_000_000;
const MAX_ERROR_CHARS = 2_000;
const MAX_TEXT_CHARS = 200_000;
const MAX_TIMEOUT_MS = 3_600_000;

const isPrompt = (value: unknown): value is string => isString(value) && value.length <= MAX_PROMPT_CHARS;
const isTimeout = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS;

export const parseDelegatedCall = (value: unknown): DelegatedCall | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { id, provider, model, effort, systemPrompt, userPrompt, schema, timeoutMs } = value;
  const valid = isDelegationId(id) && isProviderId(provider) && isModelName(model) && isEffort(effort) && isPrompt(systemPrompt) && isPrompt(userPrompt);
  return valid && isRecord(schema) && isTimeout(timeoutMs) ? { id, provider, model, effort, systemPrompt, userPrompt, schema, timeoutMs } : undefined;
};

export const parseDelegatedCalls = (value: unknown): readonly DelegatedCall[] | undefined =>
  isRecord(value) ? parseArray(value['calls'], parseDelegatedCall) : undefined;

export const parseDelegatedResult = (value: unknown): DelegatedResult | undefined => {
  if (!isRecord(value) || !isDelegationId(value['id'])) {
    return undefined;
  }
  const id = value['id'];
  const hasOutput = Object.hasOwn(value, 'output');
  const error = value['error'];
  if (hasOutput === isString(error)) {
    return undefined;
  }
  return hasOutput ? { id, output: value['output'] } : { id, error: isString(error) ? error.slice(0, MAX_ERROR_CHARS) : '' };
};

export const parseDelegatedText = (value: unknown): DelegatedText | undefined =>
  isRecord(value) && isDelegationId(value['id']) && isString(value['text']) && value['text'].length <= MAX_TEXT_CHARS
    ? { id: value['id'], text: value['text'] }
    : undefined;
