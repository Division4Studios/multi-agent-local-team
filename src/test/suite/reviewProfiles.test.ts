/** Model and effort per review type: defaults, validation, how they reach the CLI, and usage reporting. */
import assert from 'node:assert/strict';
import { REVIEW_TYPES, REVIEW_TYPE_INFO, describeProfile, isModelName, profileFrom, profilesFromEnv, profilesToEnv } from '../../shared/reviewProfiles';
import type { ReviewProfiles } from '../../shared/reviewProfiles';
import { addUsage, claudeArgs, isFormatFailure, usageFrom } from '../../reviewer/providers/claudeCode';
import { parseCallUsage, parseConversationEvent } from '../../shared/conversation';
import type { TestCase } from './harness';

const CALL = { systemPrompt: 's', userPrompt: 'u', schema: {}, model: 'haiku', effort: 'low' as const, timeoutMs: 1 };

export const tests: readonly TestCase[] = [
  {
    name: 'profiles: defaults favour low usage (Haiku checks, low effort; Opus only for the rare scan)',
    run: (): void => {
      assert.deepEqual(
        REVIEW_TYPES.map((type) => [type, REVIEW_TYPE_INFO[type].defaults.model, REVIEW_TYPE_INFO[type].defaults.effort]),
        [['overview', 'sonnet', 'low'], ['check', 'haiku', 'low'], ['consolidation', 'sonnet', 'low'], ['standards', 'opus', 'medium'], ['investigation', 'sonnet', 'medium']],
      );
    },
  },
  {
    name: 'profiles: invalid models or efforts fall back to defaults; nothing flag-like reaches the CLI',
    run: (): void => {
      assert.ok(isModelName('claude-sonnet-5-5') && isModelName('claude-opus-5-5[1m]') && isModelName('haiku'));
      for (const bad of ['--settings', '-p', '', 'a b', 'x;rm', 42, undefined]) {
        assert.equal(isModelName(bad), false, String(bad));
      }
      assert.deepEqual(profileFrom('check', '--settings', 'turbo'), REVIEW_TYPE_INFO.check.defaults);
      assert.deepEqual(profileFrom('check', 'opus', 'max'), { model: 'opus', effort: 'max' });
    },
  },
  {
    name: 'profiles: survive the trip to the reviewer process through environment variables',
    run: (): void => {
      const profiles: ReviewProfiles = {
        overview: { model: 'sonnet', effort: 'medium' },
        check: { model: 'haiku', effort: 'low' },
        consolidation: { model: 'opus', effort: 'default' },
        standards: { model: 'claude-opus-5-5', effort: 'high' },
        investigation: { model: 'opus', effort: 'xhigh' },
      };
      assert.deepEqual(profilesFromEnv(profilesToEnv(profiles)), profiles);
      assert.deepEqual(profilesFromEnv({ MALT_MODEL_CHECK: '--evil', MALT_EFFORT_CHECK: 'nope' }).check, REVIEW_TYPE_INFO.check.defaults);
      assert.equal(describeProfile({ model: 'haiku', effort: 'low' }), 'haiku · low effort');
      assert.equal(describeProfile({ model: 'opus', effort: 'default' }), 'opus · default effort');
    },
  },
  {
    name: 'cli: --effort is passed per call, and omitted for the CLI default',
    run: (): void => {
      const args = claudeArgs(CALL);
      assert.deepEqual(args.slice(0, 5), ['-p', '--model', 'haiku', '--effort', 'low']);
      assert.ok(!claudeArgs({ ...CALL, effort: 'default' }).includes('--effort'));
      for (const isolation of ['--strict-mcp-config', '--no-session-persistence']) {
        assert.ok(args.includes(isolation), `isolation flag kept: ${isolation}`);
      }
      assert.equal(args[args.indexOf('--tools') + 1], '', 'no tools');
      assert.equal(args[args.indexOf('--setting-sources') + 1], '', 'no settings');
    },
  },
  {
    name: 'usage: tokens and cost come from the result event; malformed usage is rejected on the wire',
    run: (): void => {
      const result = {
        type: 'result',
        total_cost_usd: 0.0123,
        usage: { input_tokens: 100, cache_creation_input_tokens: 900, cache_read_input_tokens: 4000, output_tokens: 250 },
      };
      assert.deepEqual(usageFrom(result), { inputTokens: 1000, outputTokens: 250, cachedTokens: 4000, costUsd: 0.0123 });
      assert.equal(usageFrom({ type: 'result' }), undefined);
      assert.deepEqual(usageFrom({ usage: { input_tokens: -5, output_tokens: 'x' }, total_cost_usd: Number.NaN }), { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 });
      assert.equal(parseCallUsage({ inputTokens: 1, outputTokens: 1, cachedTokens: 1, costUsd: -1 }), undefined);
      const end = { kind: 'end', callId: 'a1b2c3d4e5f60718', at: 1, ok: true, error: '' };
      assert.equal(parseConversationEvent({ ...end, usage: { inputTokens: 'lots' } }), undefined, 'present but invalid usage rejects the event');
      assert.deepEqual(parseConversationEvent(end), end, 'usage is optional');
    },
  },
  {
    name: 'cli: only a schema-format failure is retried, and usage adds up across attempts',
    run: (): void => {
      assert.equal(isFormatFailure({ type: 'result', subtype: 'error_max_structured_output_retries', is_error: true }), true);
      for (const other of [{ subtype: 'success' }, { subtype: 'error_max_turns' }, { result: 'Invalid API key', is_error: true }, undefined, 'error_max_structured_output_retries']) {
        assert.equal(isFormatFailure(other), false, JSON.stringify(other));
      }
      const first = { inputTokens: 100, outputTokens: 40, cachedTokens: 3000, costUsd: 0.01 };
      const second = { inputTokens: 90, outputTokens: 60, cachedTokens: 3000, costUsd: 0.02 };
      assert.deepEqual(addUsage(first, second), { inputTokens: 190, outputTokens: 100, cachedTokens: 6000, costUsd: 0.03 });
      assert.equal(addUsage(first, undefined), first);
      assert.equal(addUsage(undefined, second), second);
      assert.equal(addUsage(undefined, undefined), undefined);
    },
  },
];
