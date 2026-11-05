/** A model provider the reviewer service can use. Claude Code is first; others implement the same contract. */
import type { CallUsage } from '../../shared/conversation';
import type { Effort } from '../../shared/reviewProfiles';

export interface StructuredCall {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** JSON Schema the provider must enforce on its output. */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly model: string;
  /** Reasoning effort; `default` leaves the provider's own default. */
  readonly effort: Effort;
  readonly timeoutMs: number;
  /** Receives the answer as it streams in, for the live reviewer log. Display only; the result is the return value. */
  readonly onText?: (text: string) => void;
  /**
   * Called whenever the model sends anything (answer text, thinking, structured output, status), so a progress view
   * can tell a call that is working from one that has stalled. Liveness only; nothing is passed.
   */
  readonly onActivity?: () => void;
  /** Receives the call's token usage and cost, as the provider reports them. */
  readonly onUsage?: (usage: CallUsage) => void;
}

export interface ReviewProvider {
  readonly name: string;
  /** Runs one isolated, tool-less model call and returns its schema-validated JSON output (still untrusted). */
  callStructured: (call: StructuredCall) => Promise<unknown>;
}
