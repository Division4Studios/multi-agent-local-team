/** Codex as a review provider (#33): the isolated container, its request and answer, and the provider profile. */
import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { CodexContainer, codexContainerSpec, codexEffort, parseCodexOutput } from '../../backend/codexContainer';
import type { CodexDocker } from '../../backend/codexContainer';
import type { DockerResponse } from '../../backend/dockerApi';
import { stripNulls, toStrictSchema } from '../../backend/strictSchema';
import { NO_CODEX_KEY, codexRequest, createCodexRunner } from '../../review/codexRunner';
import { CHECK_SCHEMA, OVERVIEW_SCHEMA } from '../../reviewer/prompts';
import type { DelegatedCall } from '../../shared/delegation';
import { AUTO_MODEL, EFFORTS, REVIEW_TYPE_INFO, describeProfile, isDelegated, modelSettingFor, profileFrom, takesEffort } from '../../shared/reviewProfiles';
import type { TestCase } from './harness';

const CALL: DelegatedCall = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  provider: 'codex',
  model: AUTO_MODEL,
  effort: 'default',
  systemPrompt: 'static instructions',
  userPrompt: 'data blocks',
  schema: { type: 'object', properties: { a: { type: 'string', maxLength: 10 }, b: { type: 'string' } }, required: ['a'] },
  timeoutMs: 1_000,
};

/** Every object in a strict schema lists all its properties as required and allows no others. */
const assertStrict = (schema: unknown): void => {
  if (typeof schema !== 'object' || schema === null) {
    return;
  }
  const record = Object.fromEntries(Object.entries(schema));
  const properties: unknown = record['properties'];
  if (typeof properties === 'object' && properties !== null) {
    assert.deepEqual(record['required'], Object.keys(properties));
    assert.equal(record['additionalProperties'], false);
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      value.forEach(assertStrict);
    } else {
      assertStrict(value);
    }
  }
};

const REQUEST = { instructions: 'i', prompt: 'p', schema: {} };
const respond = (status: number): DockerResponse => ({ status, body: Buffer.from('{}') });

/**
 * A fake engine that records every request. `onBuild` and `onStart` run while the image builds and the container
 * starts, the two waits during which a call can be cancelled. The image is never present, so every run builds.
 */
const fakeDocker = (hooks: { readonly onBuild?: () => Promise<void>; readonly onStart?: () => void }): { readonly docker: CodexDocker; readonly calls: string[] } => {
  const calls: string[] = [];
  const docker: CodexDocker = {
    inspect: async (): Promise<unknown> => { calls.push('inspect'); return await Promise.resolve<unknown>(undefined); },
    build: async () => { calls.push('build'); await hooks.onBuild?.(); },
    attachStdin: async () => { calls.push('attach'); return await Promise.resolve(new Socket()); },
    sendJson: async (method, path) => {
      calls.push(`${method} ${path.split('?')[0] ?? ''}`);
      if (path.endsWith('/start')) {
        hooks.onStart?.();
      }
      return await Promise.resolve(respond(path.endsWith('/start') || method !== 'POST' ? 204 : 201));
    },
    send: async (options) => { calls.push(`${options.method} ${options.path}`); return await Promise.resolve(respond(200)); },
    logs: async () => { calls.push('logs'); return await Promise.resolve('{"output":{}}'); },
  };
  return { docker, calls };
};

const run = async (docker: CodexDocker, signal: AbortSignal, timeoutMs = 60_000): Promise<unknown> =>
  await new CodexContainer(docker, join(__dirname, '..', '..', '..'), () => undefined).run(REQUEST, { apiKey: 'k', timeoutMs, signal });

export const tests: TestCase[] = [
  {
    name: 'codex: a call cancelled while the image builds never creates a container or sends the prompt',
    run: async (): Promise<void> => {
      const controller = new AbortController();
      const { docker, calls } = fakeDocker({ onBuild: async () => { controller.abort(); await Promise.resolve(); } });
      await assert.rejects(run(docker, controller.signal), { message: 'Reviewer task cancelled' });
      assert.ok(calls.includes('build'));
      assert.ok(!calls.some((call) => call.startsWith('POST /containers')), calls.join(', '));
    },
  },
  {
    name: 'codex: a call cancelled while its container starts sends nothing, does not wait, and removes the container',
    run: async (): Promise<void> => {
      const controller = new AbortController();
      const { docker, calls } = fakeDocker({ onStart: () => { controller.abort(); } });
      await assert.rejects(run(docker, controller.signal), { message: 'Reviewer task cancelled' });
      assert.ok(!calls.some((call) => call.endsWith('/wait')), calls.join(', '));
      assert.ok(calls.some((call) => call.startsWith('DELETE /containers/')), calls.join(', '));
    },
  },
  {
    name: 'codex: an already-cancelled call does nothing, and the time budget includes the image build',
    run: async (): Promise<void> => {
      const cancelled = new AbortController();
      cancelled.abort();
      const idle = fakeDocker({});
      await assert.rejects(run(idle.docker, cancelled.signal), { message: 'Reviewer task cancelled' });
      assert.deepEqual(idle.calls, []);
      const slow = fakeDocker({ onBuild: async () => { await new Promise((resolve) => { setTimeout(resolve, 50); }); } });
      await assert.rejects(run(slow.docker, new AbortController().signal, 20), /did not answer within/u);
      assert.ok(!slow.calls.some((call) => call.startsWith('POST /containers')), slow.calls.join(', '));
    },
  },
  {
    name: 'codex: schemas become strict, optional properties nullable, and the nulls are removed from the answer',
    run: (): void => {
      assert.deepEqual(toStrictSchema(CALL.schema), {
        type: 'object',
        properties: { a: { type: 'string' }, b: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
        required: ['a', 'b'],
        additionalProperties: false,
      });
      for (const schema of [OVERVIEW_SCHEMA, CHECK_SCHEMA]) {
        assertStrict(toStrictSchema(schema));
      }
      assert.deepEqual(stripNulls({ a: 'x', b: null, list: [{ c: null, d: 1 }] }), { a: 'x', list: [{ d: 1 }] });
    },
  },
  {
    name: 'codex: the request leaves Codex its own model and effort for auto and default, and maps max to xhigh',
    run: (): void => {
      assert.deepEqual(codexRequest(CALL), { instructions: 'static instructions', prompt: 'data blocks', schema: toStrictSchema(CALL.schema) });
      const chosen = codexRequest({ ...CALL, model: 'gpt-5.5', effort: 'max' });
      assert.equal(chosen.model, 'gpt-5.5');
      assert.equal(chosen.effort, 'xhigh');
      assert.deepEqual(EFFORTS.map(codexEffort), [undefined, 'low', 'medium', 'high', 'xhigh', 'xhigh']);
    },
  },
  {
    name: 'codex: the container gets no mount, port, capability or writable root, and only the key in its environment',
    run: (): void => {
      const spec = codexContainerSpec('malt-codex:abc', 'sk-test');
      assert.deepEqual(spec['Env'], ['CODEX_API_KEY=sk-test']);
      assert.equal(spec['User'], 'node');
      assert.equal(spec['ExposedPorts'], undefined);
      const host = spec['HostConfig'];
      assert.ok(typeof host === 'object' && host !== null);
      const config = Object.fromEntries(Object.entries(host));
      assert.equal(config['Mounts'], undefined);
      assert.equal(config['Binds'], undefined);
      assert.equal(config['PortBindings'], undefined);
      assert.equal(config['ReadonlyRootfs'], true);
      assert.deepEqual(config['CapDrop'], ['ALL']);
      assert.deepEqual(config['SecurityOpt'], ['no-new-privileges']);
      assert.equal(config['Privileged'], undefined);
    },
  },
  {
    name: 'codex: the launcher answer is its last JSON line; an error line or no answer fails the call',
    run: (): void => {
      assert.deepEqual(parseCodexOutput('noise\n{"output":{"a":"x"}}\n'), { a: 'x' });
      assert.throws(() => parseCodexOutput('{"error":"Codex failed (exit code 1): 401"}\n'), /401/u);
      assert.throws(() => parseCodexOutput('Warning: something\n'), /without an answer/u);
    },
  },
  {
    name: 'codex: a call without a stored OpenAI key fails before any container starts',
    run: async (): Promise<void> => {
      const runner = createCodexRunner({ extensionRoot: '/nowhere', credentials: { codexApiKey: async (): Promise<string | undefined> => await Promise.resolve<string | undefined>(undefined) }, log: () => undefined });
      await assert.rejects(runner(CALL, () => undefined), { message: NO_CODEX_KEY });
    },
  },
  {
    name: 'codex: the profile is delegated, takes effort, keeps its own model setting and never inherits a Claude model',
    run: (): void => {
      assert.ok(isDelegated('codex'));
      assert.ok(takesEffort('codex'));
      assert.ok(!takesEffort('copilot'));
      assert.equal(modelSettingFor(REVIEW_TYPE_INFO.check, 'codex'), 'reviewer.reviewCodexModel');
      assert.deepEqual(profileFrom('check', 'haiku', 'low', 'codex'), { provider: 'codex', model: 'haiku', effort: 'low' });
      assert.deepEqual(profileFrom('check', '--flag', 'low', 'codex'), { provider: 'codex', model: AUTO_MODEL, effort: 'low' });
      assert.equal(describeProfile({ provider: 'codex', model: 'gpt-5.5', effort: 'medium' }), 'Codex · gpt-5.5 · medium effort');
    },
  },
];
