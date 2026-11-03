/**
 * Trust boundary between repository-controlled content and the model's instructions.
 *
 * Everything that comes from the reviewed repository (project rules, patches, file contents, docs) is untrusted:
 * it is sanitized where it is structured, serialized as data, and wrapped in delimiters carrying a random
 * per-request nonce, so content cannot forge the end of its block. It never enters the system prompt.
 *
 * The model's answer is untrusted too: `enforceOverviewPolicy` and `enforceCheckPolicy` re-derive what MALT can
 * verify itself.
 */
import { randomBytes } from 'node:crypto';
import type { BlockOverview, Rule, RuleCheck } from '../shared/protocol';

const RULE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_PROJECT_RULES = 60;
const FIELD_LIMITS = { title: 120, check: 300, category: 32, source: 200 };
const NOTE_LIMIT = 500;
const DETAIL_LIMIT = 6_000;

/** The baseline rule that catches prompt injection; it is checked on every block, whatever the sorting says. */
export const MANIPULATION_RULE_ID = 'no-reviewer-manipulation';

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

/** Like `sanitizeText`, but keeps line breaks so a longer explanation stays readable. */
const sanitizeDetail = (value: string): string =>
  value.replace(/\r\n?/gu, '\n').replace(/[\p{Cf}]|[^\P{Cc}\n]/gu, ' ').trim().slice(0, DETAIL_LIMIT);

/**
 * Keeps only applicable rule ids MALT knows, once each, in MALT's rule order. The manipulation check is always
 * applicable: injected text could otherwise talk the sorting call out of running the checks that would catch it.
 */
export const enforceOverviewPolicy = (overview: BlockOverview, rules: readonly Rule[]): BlockOverview => {
  const chosen = new Set([...overview.applicable, MANIPULATION_RULE_ID]);
  return { ...overview, applicable: rules.filter((rule) => chosen.has(rule.id)).map((rule) => rule.id) };
};

/** The rule id and title come from MALT's own rule, never from the model; free text is sanitized and capped. */
export const enforceCheckPolicy = (check: RuleCheck, rule: Rule): RuleCheck => ({
  ruleId: rule.id,
  title: rule.title,
  status: check.status,
  note: sanitizeText(check.note, NOTE_LIMIT),
  detail: sanitizeDetail(check.detail),
});
