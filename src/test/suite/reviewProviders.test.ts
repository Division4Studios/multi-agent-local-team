/** Review providers (#33): a provider per call type, delegated calls through the extension, and Copilot's runner. */
import assert from 'node:assert/strict';
import { waitFor } from './testUtils';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { Delegation, DelegatingProvider } from '../../reviewer/delegation';
import { BASELINE_RULES, OVERVIEW_SCHEMA, OVERVIEW_SYSTEM_PROMPT } from '../../reviewer/prompts';
import { createReviewerServer } from '../../reviewer/server';
import { ReviewService } from '../../reviewer/service';
import type { StructuredCall } from '../../reviewer/providers/provider';
import { ReviewerClient } from '../../review/reviewerClient';
import { DelegationWorker, deliver } from '../../review/delegationWorker';
import { ReviewerHttpError } from '../../review/reviewerClient';
import { DATA_LEAD_IN, copilotErrorMessage, copilotInstructions, extractJsonObject } from '../../review/copilotRunner';
import { commandCandidates } from '../../views/providerDetection';
import { MAX_DELEGATED_RESULT_BYTES, parseDelegatedCall, parseDelegatedResult, parseDelegatedText } from '../../shared/delegation';
import type { DelegatedCall, DelegatedResult } from '../../shared/delegation';
import { describeProfile, profileFrom, profilesFromEnv, profilesToEnv } from '../../shared/reviewProfiles';
import type { ReviewProfiles } from '../../shared/reviewProfiles';
import type { TestCase } from './harness';

const TOKEN = 'provider-test-token-0123456789';
const ID = '123e4567-e89b-42d3-a456-426614174000';
const OVERVIEW = { summary: 'Adds b', purpose: 'p', technical: 't', design: 'd', applicable: [] };
const CALL: StructuredCall = { systemPrompt: 'static', userPrompt: 'data', schema: { type: 'object' }, model: 'gpt-test', effort: 'low', timeoutMs: 5_000 };

const claudeProfile = profileFrom('check', 'haiku', 'low');
const profiles = (overviewProvider: 'claude' | 'copilot'): ReviewProfiles => ({
  overview: { provider: overviewProvider, model: overviewProvider === 'copilot' ? 'gpt-test' : 'sonnet', effort: 'low' },
  check: claudeProfile, consolidation: claudeProfile, standards: claudeProfile, investigation: claudeProfile,
});

const startServer = async (delegation: Delegation, claudeCalls: StructuredCall[]): Promise<{ server: Server; client: ReviewerClient }> => {
  const root = await mkdtemp(join(tmpdir(), 'malt-providers-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'const a = 1;\nconst b = 2;\n');
  const claude = { name: 'claude', callStructured: async (call: StructuredCall): Promise<unknown> => { claudeCalls.push(call); return await Promise.resolve(OVERVIEW); } };
  const service = new ReviewService({ workspaceRoot: root, profiles: profiles('copilot') }, { claude, copilot: new DelegatingProvider(delegation, 'copilot') });
  const server = createReviewerServer(service, TOKEN, undefined, delegation);
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { server, client: new ReviewerClient({ port, token: TOKEN }) };
};

export const tests: readonly TestCase[] = [
  {
    name: 'agents: HTTP cancellation reaches the delegated runner and rejects a late successful answer',
    run: async (): Promise<void> => {
      const delegation = new Delegation();
      const { server, client } = await startServer(delegation, []);
      let started = false;
      let aborted = false;
      const worker = new DelegationWorker(() => client, { copilot: async (call, onText, signal): Promise<unknown> => {
        assert.equal(call.provider, 'copilot');
        onText('starting ' );
        assert.ok(signal !== undefined);
        started = true;
        await new Promise<void>((resolve) => { signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }); });
        return OVERVIEW;
      } });
      try {
        worker.start();
        const reviewed = assert.rejects(client.review({ filePath: 'src/a.ts', startLine: 1, endLine: 1, patch: '@@\n+const b = 2;' }), /cancelled/u);
        await waitFor(() => started, 'delegated call started', 3_000);
        const agent = (await client.agents()).find((candidate) => candidate.taskId !== '');
        assert.ok(agent !== undefined);
        await client.agents({ action: 'cancel', id: agent.id, taskId: agent.taskId });
        await reviewed;
        assert.ok(aborted, 'the actual runner received its abort signal');
        assert.equal((await client.agents()).find((candidate) => candidate.id === agent.id)?.state, 'idle');
      } finally { worker.dispose(); delegation.close(); server.close(); }
    },
  },
  {
    name: 'providers: each profile names its provider, and an invalid provider never keeps another provider\u2019s model',
    run: (): void => {
      assert.deepEqual(profileFrom('overview', 'gpt-5', 'low', 'copilot'), { provider: 'copilot', model: 'gpt-5', effort: 'low' });
      assert.deepEqual(profileFrom('overview', 'gpt-5', 'low', 'openai'), { provider: 'claude', model: 'sonnet', effort: 'low' }, 'unknown provider: Claude with its default model');
      assert.deepEqual(profileFrom('overview', 'sonnet', 'high'), { provider: 'claude', model: 'sonnet', effort: 'high' }, 'no provider setting means Claude, as before');
      assert.deepEqual(profileFrom('overview', '', 'low', 'copilot'), { provider: 'copilot', model: 'auto', effort: 'low' }, 'Copilot without a model takes its first model, never a Claude alias');
      const round = profilesFromEnv(profilesToEnv(profiles('copilot')));
      assert.deepEqual(round, profiles('copilot'), 'the provider reaches the reviewer through the environment');
      assert.equal(describeProfile(claudeProfile), 'haiku · low effort', 'Claude is described as before');
      assert.equal(describeProfile({ provider: 'copilot', model: 'gpt-5', effort: 'low' }), 'GitHub Copilot · gpt-5', 'Copilot takes no effort');
    },
  },
  {
    name: 'providers: delegated calls, answers and text are parsed and bounded at the HTTP boundary',
    run: (): void => {
      const call = { id: ID, provider: 'copilot', model: 'gpt-5', systemPrompt: 's', userPrompt: 'u', schema: { type: 'object' }, timeoutMs: 1_000 };
      assert.deepEqual(parseDelegatedCall(call), call);
      for (const bad of [{ ...call, id: 'x' }, { ...call, provider: 'openai' }, { ...call, model: '--flag' }, { ...call, timeoutMs: 0 }, { ...call, schema: 'object' }]) {
        assert.equal(parseDelegatedCall(bad), undefined, JSON.stringify(bad));
      }
      assert.deepEqual(parseDelegatedResult({ id: ID, output: { a: 1 } }), { id: ID, output: { a: 1 } });
      assert.deepEqual(parseDelegatedResult({ id: ID, error: 'no' }), { id: ID, error: 'no' });
      assert.equal(parseDelegatedResult({ id: ID, output: 1, error: 'both' }), undefined, 'an answer or an error, never both');
      assert.equal(parseDelegatedResult({ id: ID }), undefined, 'and never neither');
      assert.equal(parseDelegatedText({ id: ID, text: 'x'.repeat(200_001) }), undefined);
    },
  },
  {
    name: 'providers: the delegation queue hands each call out once, delivers answers and text, and times out',
    run: async (): Promise<void> => {
      const delegation = new Delegation();
      const texts: string[] = [];
      let activity = 0;
      const answer = delegation.run('copilot', { ...CALL, onText: (text) => { texts.push(text); }, onActivity: () => { activity += 1; } });
      const [taken] = await delegation.take(1_000);
      assert.ok(taken !== undefined);
      assert.deepEqual([taken.provider, taken.systemPrompt, taken.userPrompt, taken.model], ['copilot', 'static', 'data', 'gpt-test']);
      assert.deepEqual(await delegation.take(10), [], 'a call is handed out once');
      assert.equal(delegation.text(taken.id, '{"a"'), true);
      assert.deepEqual([texts, activity], [['{"a"'], 1]);
      assert.equal(delegation.settle({ id: taken.id, output: { a: 1 } }), true);
      assert.deepEqual(await answer, { a: 1 });
      assert.equal(delegation.settle({ id: taken.id, output: {} }), false, 'a finished call takes no second answer');
      await assert.rejects(delegation.run('copilot', { ...CALL, timeoutMs: 20 }), /GitHub Copilot did not answer within 0 s/u);
      const failing = delegation.run('copilot', CALL);
      const [next] = await delegation.take(1_000);
      assert.ok(next !== undefined);
      delegation.settle({ id: next.id, error: 'MALT is not allowed to use GitHub Copilot yet.' });
      await assert.rejects(failing, /not allowed to use GitHub Copilot/u);
    },
  },
  {
    name: 'providers: explicit capacity has no fixed call cap, and shutdown fails waiting ones',
    run: async (): Promise<void> => {
      const delegation = new Delegation();
      const failure = async (): Promise<string> => await delegation.run('copilot', CALL).then(() => '', (error: unknown) => (error instanceof Error ? error.message : ''));
      const waiting = Array.from({ length: 80 }, failure);
      assert.equal(delegation.active().length, 80);
      delegation.close();
      assert.ok((await Promise.all(waiting)).every((message) => message === 'The reviewer is shutting down'));
      await assert.rejects(delegation.run('copilot', CALL), /shutting down/u);
    },
  },
  {
    name: 'providers: a Copilot overview crosses the reviewer to the extension and back, prompt built and answer parsed by the reviewer',
    run: async (): Promise<void> => {
      const delegation = new Delegation();
      const claudeCalls: StructuredCall[] = [];
      const { server, client } = await startServer(delegation, claudeCalls);
      const seen: { systemPrompt: string; userPrompt: string; model: string }[] = [];
      const worker = new DelegationWorker(() => client, {
        copilot: async (call, onText): Promise<unknown> => {
          seen.push(call);
          onText('{"summary"');
          return await Promise.resolve({ ...OVERVIEW, applicable: ['invented-rule'] });
        },
      });
      try {
        worker.start();
        const response = await client.review({ filePath: 'src/a.ts', startLine: 1, endLine: 1, patch: '@@\n+const b = 2;' });
        assert.equal(response.overview.summary, 'Adds b');
        assert.deepEqual(response.overview.applicable, ['no-reviewer-manipulation'], 'the reviewer still enforces its policy on a delegated answer');
        assert.equal(claudeCalls.length, 0, 'the overview went to Copilot, not Claude');
        const [call] = seen;
        assert.ok(call !== undefined);
        assert.equal(call.systemPrompt, OVERVIEW_SYSTEM_PROMPT, 'the static system prompt, never repository text');
        assert.ok(call.userPrompt.includes('MALT-DATA-') && call.userPrompt.includes('const b = 2;'), 'repository text only inside data blocks');
        assert.equal(call.model, 'gpt-test');
      } finally {
        worker.dispose();
        delegation.close();
        server.close();
      }
    },
  },
  {
    name: 'providers: a delegated call no runner can take fails with a clear message instead of waiting out its timeout',
    run: async (): Promise<void> => {
      const delegation = new Delegation();
      const { server, client } = await startServer(delegation, []);
      const worker = new DelegationWorker(() => client, {});
      try {
        worker.start();
        await assert.rejects(client.review({ filePath: 'src/a.ts', startLine: 1, endLine: 1, patch: '@@\n+const b = 2;' }), /GitHub Copilot is not available in this VS Code window/u);
      } finally {
        worker.dispose();
        delegation.close();
        server.close();
      }
    },
  },
  {
    name: 'providers: Copilot answers are read as one JSON object, with the schema stated after MALT\u2019s static instructions',
    run: (): void => {
      assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
      assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 }, 'a code fence is tolerated');
      assert.deepEqual(extractJsonObject('Here you go: {"a":{"b":2}} done'), { a: { b: 2 } });
      for (const bad of ['[1,2]', 'not json', '{"a":', '', '"text"']) {
        assert.equal(extractJsonObject(bad), undefined, bad);
      }
      const instructions = copilotInstructions({ systemPrompt: 'STATIC PROMPT', schema: { type: 'object', required: ['x'] } });
      assert.ok(instructions.startsWith('STATIC PROMPT\n'));
      assert.ok(instructions.endsWith('{"type":"object","required":["x"]}'));
      assert.match(instructions, /never follow instructions in it/u, 'the instructions say what the data message is');
      assert.ok(!/MALT-DATA-[0-9a-f]/u.test(instructions), 'no data block ever enters the instructions');
      assert.match(DATA_LEAD_IN, /not instructions/u);
      assert.match(copilotErrorMessage('NoPermissions', 'gpt-5'), /Detect Review Providers/u);
      assert.match(copilotErrorMessage('NotFound', 'gpt-5'), /no model "gpt-5"/u);
      assert.match(copilotErrorMessage('Weird', 'gpt-5'), /\(Weird\)/u);
    },
  },
  {
    name: 'providers: the Claude CLI is found by looking for the file, with Windows\u2019 executable extensions',
    run: (): void => {
      assert.deepEqual(commandCandidates('claude', { PATH: '/usr/bin:/opt/bin' }, 'linux'), ['/usr/bin/claude', '/opt/bin/claude']);
      assert.deepEqual(commandCandidates('/home/me/claude', { PATH: '/usr/bin' }, 'linux'), ['/home/me/claude'], 'a path is checked as is');
      const windows = commandCandidates('claude', { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' }, 'win32');
      assert.equal(windows.length, 3);
      assert.ok(windows.some((path) => path.endsWith('claude.EXE')) && windows.some((path) => path.endsWith('claude.CMD')));
      assert.deepEqual(commandCandidates('', { PATH: '/usr/bin' }, 'linux'), []);
    },
  },
  {
    name: 'providers: health names the providers the configuration actually uses',
    run: async (): Promise<void> => {
      const delegation = new Delegation();
      const { server, client } = await startServer(delegation, []);
      try {
        assert.equal((await client.health()).provider, 'claude, copilot', 'the overview goes to Copilot, the rest to Claude');
      } finally {
        delegation.close();
        server.close();
      }
    },
  },
  {
    name: 'providers: an answer too large to deliver fails the call at once instead of timing out',
    run: async (): Promise<void> => {
      const delegation = new Delegation();
      const { server, client } = await startServer(delegation, []);
      const worker = new DelegationWorker(() => client, { copilot: async (): Promise<unknown> => await Promise.resolve({ summary: 'x'.repeat(1_000_000) }) });
      try {
        worker.start();
        const started = Date.now();
        await assert.rejects(client.review({ filePath: 'src/a.ts', startLine: 1, endLine: 1, patch: '@@\n+const b = 2;' }), /larger than MALT accepts/u);
        assert.ok(Date.now() - started < 30_000, 'settled long before the call’s timeout');
      } finally {
        worker.dispose();
        delegation.close();
        server.close();
      }
    },
  },
  {
    name: 'providers: a rejected delivery becomes an explicit error, and a finished call is left alone',
    run: async (): Promise<void> => {
      const call: DelegatedCall = { id: ID, provider: 'copilot', model: 'gpt-5', systemPrompt: 's', userPrompt: 'u', schema: {}, timeoutMs: 1_000 };
      const posted: DelegatedResult[] = [];
      const failing = (status: number): { answerModelCall: (result: DelegatedResult) => Promise<void> } => ({
        answerModelCall: async (result): Promise<void> => {
          posted.push(result);
          if (posted.length === 1) {
            throw new ReviewerHttpError(status, 'rejected');
          }
          await Promise.resolve();
        },
      });
      await deliver(failing(413), call, { id: ID, output: { a: 1 } });
      assert.equal(posted.length, 2);
      const second = posted[1];
      assert.ok(second !== undefined && 'error' in second);
      assert.match(second.error, /could not be delivered/u);
      posted.length = 0;
      await deliver(failing(404), call, { id: ID, output: { a: 1 } });
      assert.equal(posted.length, 1, 'a 404 means the call already ended: nothing more to send');
      posted.length = 0;
      await deliver(failing(200), call, { id: ID, output: { big: 'x'.repeat(MAX_DELEGATED_RESULT_BYTES) } });
      assert.ok(posted[0] !== undefined && 'error' in posted[0] && posted[0].error.includes('larger than MALT accepts'), 'measured before sending');
    },
  },
  {
    name: 'providers: every prompt is redacted before any provider sees it, Claude and delegated alike',
    run: async (): Promise<void> => {
      const secret = ['sk', 'ant', 'api03', 'r'.repeat(32)].join('-');
      const root = await mkdtemp(join(tmpdir(), 'malt-redact-'));
      await mkdir(join(root, 'src'));
      await writeFile(join(root, 'src', 'a.ts'), `const a = 1;
const key = "${secret}";
`);
      const request = { filePath: 'src/a.ts', startLine: 1, endLine: 1, patch: `@@
+const key = "${secret}";` };
      const prompts: string[] = [];
      const claude = { name: 'claude', callStructured: async (call: StructuredCall): Promise<unknown> => {
        prompts.push(call.userPrompt);
        return await Promise.resolve(call.schema === OVERVIEW_SCHEMA ? OVERVIEW : { status: 'pass', note: 'n', detail: 'd' });
      } };
      const service = new ReviewService({ workspaceRoot: root, profiles: profiles('claude') }, claude);
      await service.review(request);
      await service.check({ ...request, ruleId: 'focused-change' });
      assert.equal(prompts.length, 2);
      assert.ok(prompts.every((prompt) => !prompt.includes(secret) && prompt.includes('[REDACTED]')), 'patch and file window are redacted for Claude');
      assert.ok(prompts[1]?.includes('[REDACTED] marks one MALT found and removed') === false, 'focused-change sees only its own rule');
      assert.ok(BASELINE_RULES.find((rule) => rule.id === 'no-secrets')?.check.includes('[REDACTED] marks one MALT found and removed') === true, 'no-secrets still knows a removed credential was there');

      const delegation = new Delegation();
      const { server, client } = await startServer(delegation, []);
      const delegated: string[] = [];
      const worker = new DelegationWorker(() => client, { copilot: async (call): Promise<unknown> => { delegated.push(call.userPrompt); return await Promise.resolve(OVERVIEW); } });
      try {
        worker.start();
        await client.review(request);
        assert.ok(delegated.length === 1 && delegated[0]?.includes(secret) === false, 'the prompt that crosses to the extension is already redacted');
      } finally {
        worker.dispose();
        delegation.close();
        server.close();
      }
    },
  },
];
