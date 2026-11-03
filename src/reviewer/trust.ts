/**
 * Trust boundary between repository-controlled content and the model's instructions.
 *
 * Everything that comes from the reviewed repository (project rules, patches, file contents, docs) is untrusted:
 * it is sanitized where it is structured, serialized as data, and wrapped in delimiters carrying a random
 * per-request nonce, so content cannot forge the end of its block. It never enters the system prompt.
 *
 * The model's answer is untrusted too: `enforceReviewPolicy` re-derives what MALT can verify itself.
 */
import { randomBytes } from 'node:crypto';
import type { HunkReview, Rule, RuleCheck } from '../shared/protocol';

const RULE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_PROJECT_RULES = 60;
const FIELD_LIMITS = { title: 120, check: 300, category: 32, source: 200 };
const NOTE_LIMIT = 500;

/** Replaces control and format characters (incl. zero-width/bidi), collapses whitespace and caps length. */
export const sanitizeText = (value: string, maxLength: number): string =>
  value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maxLength);

/**
 * Keeps only well-formed project rules: valid unique ids that do not shadow a trusted rule, sanitized fields,
 * at most MAX_PROJECT_RULES of them.
 */
export const sanitizeProjectRules = (rules: readonly Rule[], trusted: readonly Rule[]): Rule[] => {
  const taken = new Set(trusted.map((rule) => rule.id));
  const result: Rule[] = [];
  for (const rule of rules) {
    if (result.length >= MAX_PROJECT_RULES || !RULE_ID.test(rule.id) || taken.has(rule.id)) {
      continue;
    }
    taken.add(rule.id);
    result.push({
      id: rule.id,
      title: sanitizeText(rule.title, FIELD_LIMITS.title),
      check: sanitizeText(rule.check, FIELD_LIMITS.check),
      category: sanitizeText(rule.category, FIELD_LIMITS.category),
      source: sanitizeText(rule.source, FIELD_LIMITS.source),
    });
  }
  return result;
};

export const createNonce = (): string => randomBytes(12).toString('hex');

/** Block labels are trusted constants written by MALT: lowercase words, hyphens and parentheses only. */
const SAFE_LABEL = /^[a-z][a-z0-9 ()-]{0,60}$/u;

/**
 * Wraps untrusted content in nonce-tagged delimiters; content cannot close the block without the nonce.
 * The label is part of the framing, so it must be a trusted constant. Repository-controlled text (including
 * file paths) belongs in `content`. Unsafe labels are rejected so this cannot regress.
 */
export const dataBlock = (nonce: string, label: string, content: string): string => {
  if (!SAFE_LABEL.test(label)) {
    throw new Error('dataBlock labels must be trusted constants; put untrusted text in the content');
  }
  return `<<<MALT-DATA-${nonce} ${label}>>>\n${content}\n<<<END-MALT-DATA-${nonce}>>>`;
};

const failClosed = (rule: Rule): RuleCheck => ({
  ruleId: rule.id,
  title: rule.title,
  status: 'fail',
  note: 'The reviewer did not evaluate this rule, so it is treated as failed.',
});

/**
 * Re-derives what MALT can verify instead of trusting the model:
 * - checks for unknown rules and duplicates are dropped; titles come from MALT's own rule list;
 * - every rule the model skipped is recorded as failed (fail closed);
 * - "pass" is never reported alongside a failing check.
 */
export const enforceReviewPolicy = (review: HunkReview, rules: readonly Rule[]): HunkReview => {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const seen = new Set<string>();
  const checks: RuleCheck[] = [];
  for (const check of review.checks) {
    const rule = byId.get(check.ruleId);
    if (rule !== undefined && !seen.has(rule.id)) {
      seen.add(rule.id);
      checks.push({ ruleId: rule.id, title: rule.title, status: check.status, note: sanitizeText(check.note, NOTE_LIMIT) });
    }
  }
  checks.push(...rules.filter((rule) => !seen.has(rule.id)).map(failClosed));
  const anyFailed = checks.some((check) => check.status === 'fail');
  return { ...review, verdict: anyFailed && review.verdict === 'pass' ? 'concerns' : review.verdict, checks };
};
