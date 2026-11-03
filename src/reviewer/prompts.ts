/**
 * Prompts and output schemas. The review system prompt depends only on the rules, so it is byte-identical
 * across reviews and stays prompt-cached; each block is reviewed in a fresh, isolated call.
 */
import type { ReviewRequest, Rule } from '../shared/protocol';
import type { FileWindow } from './workspace';
import type { SourceFile } from './standardsSources';

/** Always-on checks, used alongside (or instead of) project rules. */
export const BASELINE_RULES: readonly Rule[] = [
  {
    id: 'focused-change',
    title: 'Change is focused',
    check: 'Does this block do one coherent thing, without unrelated edits mixed in?',
    category: 'scope',
    source: 'MALT baseline',
  },
  {
    id: 'no-dead-code',
    title: 'No dead or speculative code',
    check: 'Is every added line used, with no unused code paths, placeholder logic or speculative abstractions?',
    category: 'quality',
    source: 'MALT baseline',
  },
  {
    id: 'reuse-existing',
    title: 'Reuses existing code',
    check: 'Does it reuse existing helpers, components and patterns visible in the file instead of duplicating them?',
    category: 'architecture',
    source: 'MALT baseline',
  },
  {
    id: 'no-secrets',
    title: 'No secrets or unsafe input handling',
    check: 'Is it free of hard-coded secrets, and does it avoid passing unvalidated input to shells, SQL, HTML or eval?',
    category: 'security',
    source: 'MALT baseline',
  },
];

const formatRules = (rules: readonly Rule[]): string =>
  rules.map((rule) => `- [${rule.id}] (${rule.category}) ${rule.title}: ${rule.check} (source: ${rule.source})`).join('\n');

export const buildReviewSystemPrompt = (projectRules: readonly Rule[]): string =>
  [
    'You are MALT, a surgical code reviewer. You review exactly ONE changed block from a larger change.',
    'Judge only the changed lines (marked + and - in the patch). Surrounding code is context, not review scope.',
    'Explain for a human reviewer who has not seen the change before:',
    '- what: what the changed block does, concretely, in one or two sentences.',
    '- why: the most likely reason for the change, inferred from the code. Say so if it is unclear.',
    '- necessity: whether the change is needed as written, or could be smaller, removed or reuse existing code.',
    'Then evaluate every rule below and return one check per rule, with status "pass", "fail" or "not-applicable"',
    'and a short note. Use "not-applicable" when the rule does not concern this block. Never invent rules.',
    'verdict: "pass" if no rule fails, "concerns" for minor issues, "fail" for a clear rule violation or bug.',
    'summary: at most 12 words. Be direct and specific; no praise, no filler.',
    '',
    'Rules:',
    formatRules([...BASELINE_RULES, ...projectRules]),
  ].join('\n');

export const buildReviewUserPrompt = (request: ReviewRequest, window: FileWindow): string =>
  [
    `File: ${request.filePath}`,
    `Changed lines: ${String(request.startLine + 1)}-${String(request.endLine + 1)}`,
    '',
    'Patch for this block:',
    '```diff',
    request.patch,
    '```',
    '',
    'Current file around the block (line-numbered):',
    '```',
    window.text,
    '```',
  ].join('\n');

export const STANDARDS_SYSTEM_PROMPT = [
  'You extract a project\'s coding standards into short, checkable rules for automated review of small diffs.',
  'Read the provided files: agent skills and instructions, documentation, and lint/format configuration.',
  'Produce rules that a reviewer can verify by looking at a single changed block of code.',
  'Cover, where the sources support it: naming and style conventions not already enforced by a linter,',
  'architectural boundaries and layering decisions, proper abstraction (no premature or duplicate abstractions),',
  'reuse of existing components, utilities and visual/UI components, error handling, testing expectations,',
  'security practices and dependency policy.',
  'Each rule: id (kebab-case, unique), title (at most 8 words), check (one yes/no question), category',
  '(one word, e.g. style, architecture, reuse, testing, security, dependencies) and source (the file path it came from).',
  'Only include rules grounded in the sources. Merge duplicates. Prefer 10 to 40 high-signal rules.',
].join('\n');

export const buildStandardsUserPrompt = (sources: readonly SourceFile[]): string =>
  sources.map((source) => `===== ${source.path} =====\n${source.content}`).join('\n\n');

const RULE_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    ruleId: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string', enum: ['pass', 'fail', 'not-applicable'] },
    note: { type: 'string' },
  },
  required: ['ruleId', 'title', 'status', 'note'],
  additionalProperties: false,
};

export const HUNK_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'concerns', 'fail'] },
    summary: { type: 'string' },
    what: { type: 'string' },
    why: { type: 'string' },
    necessity: { type: 'string' },
    checks: { type: 'array', items: RULE_CHECK_SCHEMA },
  },
  required: ['verdict', 'summary', 'what', 'why', 'necessity', 'checks'],
  additionalProperties: false,
};

export const RULES_SCHEMA = {
  type: 'object',
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          check: { type: 'string' },
          category: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['id', 'title', 'check', 'category', 'source'],
        additionalProperties: false,
      },
    },
  },
  required: ['rules'],
  additionalProperties: false,
};
