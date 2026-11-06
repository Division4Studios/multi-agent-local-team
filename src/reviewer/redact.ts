/**
 * Secret redaction for the live reviewer log. Prompts, streamed answers and error text can contain credentials
 * copied from the workspace; the log masks recognizable ones before they are kept or sent to a viewer.
 *
 * Redaction is best effort (it cannot know every secret format), so the log also stays in memory only, needs the
 * reviewer's token, and is never written to disk. Every prompt is also redacted before any provider sees it
 * (`ReviewService.ask`); the `no-secrets` rule tells the model that `[REDACTED]` marks a credential MALT removed.
 */

const MASK = '[REDACTED]';

/** Credential formats that stand alone (no surrounding key needed). */
const TOKENS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/gu,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/gu,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/gu,
  /\bAIza[0-9A-Za-z_-]{35}\b/gu,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu,
  /\bnpm_[A-Za-z0-9]{36}\b/gu,
];

/** Names that mark a value as a credential (`password`, `api_key`, `CLIENT_SECRET`, `authToken`, …). */
const SECRET_NAME = String.raw`(?:[A-Za-z0-9_]*[_-])?(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)[A-Za-z0-9_]*`;

/**
 * Keyed secrets: keep the key, mask the value. Only shapes that hold literal values are matched (a quoted string
 * assigned to a secret-named key, or a `.env`-style line), so code such as `token: string` or
 * `const token = getToken()` is left readable.
 */
const KEYED: readonly [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/gu, `$1 ${MASK}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/giu, `$1:${MASK}@`],
  [new RegExp(String.raw`\b(${SECRET_NAME}["']?\s*[:=]\s*)(["'\x60])[^"'\x60\n]{6,}\2`, 'giu'), `$1$2${MASK}$2`],
  [new RegExp(String.raw`^(\s*(?:export\s+)?${SECRET_NAME}\s*=\s*)[^\s#"']{6,}`, 'gimu'), `$1${MASK}`],
];

export const redactSecrets = (text: string): string => {
  let result = text;
  for (const pattern of TOKENS) {
    result = result.replace(pattern, MASK);
  }
  for (const [pattern, replacement] of KEYED) {
    result = result.replace(pattern, replacement);
  }
  return result;
};

/** A run of text with no whitespace longer than this is released anyway, keeping MIN_TAIL_CHARS held back. */
const MAX_HELD_CHARS = 4_096;
const MIN_TAIL_CHARS = 256;
/** An unterminated private-key block is held back until it ends, up to this size. */
const MAX_PEM_CHARS = 64_000;

/** Released text must never end with a credential's key: hold the key back until its value has arrived. */
const KEY_AT_END = new RegExp(String.raw`(?:\b(?:Bearer|Basic)|\b${SECRET_NAME}["']?\s*[:=])\s*["'\x60]?\s*$`, 'iu');

const safeCut = (pending: string): number => {
  const pemStart = pending.lastIndexOf('-----BEGIN ');
  if (pemStart >= 0 && !pending.includes('-----END ', pemStart) && pending.length < MAX_PEM_CHARS) {
    return pemStart;
  }
  // Standalone secrets contain no whitespace, so text up to the last whitespace is complete.
  let cut = pending.search(/\s(?=\S*$)/u) + 1;
  if (cut === 0 && pending.length > MAX_HELD_CHARS) {
    cut = pending.length - MIN_TAIL_CHARS;
  }
  const key = KEY_AT_END.exec(pending.slice(0, cut));
  return key === null ? cut : key.index;
};

/**
 * Redacts a stream whose secrets may be split across chunks, releasing text word by word (so the live log still
 * streams): only up to the last whitespace, never a credential's key without its value, never part of a private-key
 * block. Whatever is held is released, redacted, by `flush`.
 */
export class StreamRedactor {
  private pending = '';

  /** Adds a chunk; returns the redacted text that is now safe to release (possibly empty). */
  public push(chunk: string): string {
    this.pending += chunk;
    const cut = safeCut(this.pending);
    if (cut <= 0) {
      return '';
    }
    const ready = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return redactSecrets(ready);
  }

  /** Releases whatever is held, redacted. */
  public flush(): string {
    const rest = this.pending;
    this.pending = '';
    return redactSecrets(rest);
  }
}
