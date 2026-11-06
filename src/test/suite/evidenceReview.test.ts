import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewWithEvidence } from '../../reviewer/evidenceReview';
import type { EvidenceScope } from '../../reviewer/evidenceReview';
import { ReviewService } from '../../reviewer/service';
import type { StructuredCall } from '../../reviewer/providers/provider';
import { profilesFromEnv } from '../../shared/reviewProfiles';
import type { ReviewRequest } from '../../shared/protocol';
import type { TestCase } from './harness';

const BLOCK: ReviewRequest = { filePath: 'src/changed.ts', startLine: 0, endLine: 0, patch: '+export const changed = 1;' };
const PASS = { status: 'pass', note: 'Enough evidence', detail: 'The caller supplies the expected value.' };
const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'malt-evidence-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'far', 'elsewhere'), { recursive: true });
  await writeFile(join(root, 'src', 'changed.ts'), 'export const changed = 1;');
  await writeFile(join(root, 'far', 'elsewhere', 'other.ts'), 'export const remoteEvidence = 2;');
  await writeFile(join(root, 'far', 'elsewhere', 'second.ts'), 'export const secondEvidence = 3;');
  await writeFile(join(root, 'far', 'elsewhere', 'third.ts'), 'export const thirdEvidence = 4;');
  await writeFile(join(root, '.env'), 'PRIVATE=never-supplied');
  return root;
};
const config = (root: string, startWithComponent = false): Parameters<typeof reviewWithEvidence>[0] => ({
  root, blocks: [BLOCK], startWithComponent, loadModules: async () => await Promise.resolve([]),
});
const need = (files: readonly string[]): unknown => ({ needsContext: { files, reason: 'Check the supporting implementation before deciding.' } });

export const tests: readonly TestCase[] = [
  {
    name: 'adaptive evidence asks for a remote complete implementation before deciding',
    run: async (): Promise<void> => {
      const root = await fixture();
      const scopes: EvidenceScope[] = [];
      const result = await reviewWithEvidence(config(root), async (scope) => {
        scopes.push(scope);
        return await Promise.resolve(scopes.length === 1 ? need(['far/elsewhere/other.ts']) : PASS);
      });
      assert.equal(scopes.length, 2);
      assert.equal(scopes[0]?.component, undefined);
      assert.ok(scopes[0]?.inventory.includes('far/elsewhere/other.ts') === true);
      assert.ok(scopes[1]?.component?.files.some((file) => file.path === 'far/elsewhere/other.ts' && file.content.includes('1| export const remoteEvidence = 2;')) === true);
      assert.equal(result.scope.requests.length, 1);
      assert.deepEqual(result.output, PASS);
    },
  },
  {
    name: 'a request for evidence already supplied is asked again, marked, and the model decides from what it has',
    run: async (): Promise<void> => {
      const root = await fixture();
      const scopes: EvidenceScope[] = [];
      const result = await reviewWithEvidence(config(root, true), async (scope) => {
        scopes.push(scope);
        return await Promise.resolve(scopes.length === 1 ? need([]) : PASS);
      });
      assert.deepEqual(result.output, PASS);
      const [first, second] = scopes;
      assert.ok(scopes.length === 2 && first !== undefined && second !== undefined);
      assert.equal(second.requests[0]?.alreadySupplied, true);
      assert.equal(second.component, first.component, 'nothing new is read for a request that adds nothing');
    },
  },
  {
    name: 'adaptive evidence stops on unsafe, unknown, oversized or repeated evidence instead of a verdict',
    run: async (): Promise<void> => {
      const root = await fixture();
      for (const files of [['../outside.ts'], ['.env'], ['src/missing.ts']]) {
        await assert.rejects(reviewWithEvidence(config(root), async () => await Promise.resolve(need(files))), /outside the eligible/u);
      }
      await writeFile(join(root, 'far', 'elsewhere', 'large.ts'), 'x'.repeat(400_001));
      await assert.rejects(reviewWithEvidence(config(root), async () => await Promise.resolve(need(['far/elsewhere/large.ts']))), /complete source files/u);
      let calls = 0;
      await assert.rejects(reviewWithEvidence(config(root, true), async () => { calls += 1; return await Promise.resolve(need([])); }), /after two expansions/u);
      assert.equal(calls, 3, 'asking again for what it has ends as incomplete after the two expansions');
      calls = 0;
      await assert.rejects(reviewWithEvidence(config(root), async () => { calls += 1; return await Promise.resolve(need(['far/elsewhere/other.ts'])); }), /after two expansions/u);
      assert.equal(calls, 3);
    },
  },
  {
    name: 'adaptive evidence permits two expansions then reports insufficient context without extra calls',
    run: async (): Promise<void> => {
      const root = await fixture();
      const paths = ['far/elsewhere/other.ts', 'far/elsewhere/second.ts', 'far/elsewhere/third.ts'];
      let calls = 0;
      await assert.rejects(reviewWithEvidence(config(root), async () => {
        const path = paths[calls++];
        assert.ok(path !== undefined);
        return await Promise.resolve(need([path]));
      }), /after two expansions/u);
      assert.equal(calls, 3);
    },
  },
  {
    name: 'ordinary rule checks can request component context while retaining one-rule isolation',
    run: async (): Promise<void> => {
      const root = await fixture();
      const calls: StructuredCall[] = [];
      const service = new ReviewService({ workspaceRoot: root, profiles: profilesFromEnv({}) }, {
        name: 'fake', callStructured: async (call): Promise<unknown> => {
          calls.push(call);
          return await Promise.resolve(calls.length === 1 ? need(['far/elsewhere/other.ts']) : PASS);
        },
      });
      const check = await service.check({ ...BLOCK, ruleId: 'focused-change' });
      assert.equal(check.status, 'pass');
      assert.equal(calls.length, 2);
      const [first, second] = calls;
      assert.ok(first !== undefined && second !== undefined);
      assert.ok(first.userPrompt.includes('far/elsewhere/other.ts'));
      assert.ok(!first.userPrompt.includes('remoteEvidence = 2'));
      assert.ok(second.userPrompt.includes('remoteEvidence = 2'));
      assert.ok(calls.every((call) => !call.userPrompt.includes('justified-abstraction')));
      assert.equal(first.systemPrompt, second.systemPrompt);
    },
  },
  {
    name: 'an answer that requests evidence never counts as a verdict, and needs-context alone is not one',
    run: async (): Promise<void> => {
      const root = await fixture();
      const answers: unknown[] = [];
      const service = new ReviewService({ workspaceRoot: root, profiles: profilesFromEnv({}) }, {
        name: 'fake', callStructured: async (): Promise<unknown> => await Promise.resolve(answers.shift()),
      });
      // A pass alongside a request is ignored: MALT supplies the evidence and asks again.
      answers.push(
        { ...PASS, needsContext: { files: ['far/elsewhere/other.ts'], reason: 'Check the supporting implementation before deciding.' } },
        { status: 'fail', note: 'Duplicate', detail: 'Repeats remoteEvidence.' },
      );
      assert.equal((await service.check({ ...BLOCK, ruleId: 'focused-change' })).status, 'fail');
      // The request status without a request is not a verdict.
      answers.push({ status: 'needs-context', note: '', detail: '' });
      await assert.rejects(service.check({ ...BLOCK, ruleId: 'focused-change' }), /does not match the protocol/u);
    },
  },
];
