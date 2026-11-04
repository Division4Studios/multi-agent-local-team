/** A model provider the reviewer service can use. Claude Code is first; others implement the same contract. */
export interface StructuredCall {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** JSON Schema the provider must enforce on its output. */
  readonly schema: Readonly<Record<string, unknown>>;
  readonly model: string;
  readonly timeoutMs: number;
  /** Receives the answer as it streams in, for the live reviewer log. Display only; the result is the return value. */
  readonly onText?: (text: string) => void;
}

export interface ReviewProvider {
  readonly name: string;
  /** Runs one isolated, tool-less model call and returns its schema-validated JSON output (still untrusted). */
  callStructured: (call: StructuredCall) => Promise<unknown>;
}
