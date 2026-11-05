import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectComponentContext, needsComponentContext } from '../../reviewer/reviewContext';
import { readFileWindow } from '../../reviewer/workspace';
import { BASELINE_RULES, buildCheckUserPrompt, buildConsolidationUserPrompt } from '../../reviewer/prompts';
import type { ArchitectureModule, ReviewRequest } from '../../shared/protocol';
import type { TestCase } from './harness';

const BLOCK: ReviewRequest = { filePath: 'src/component.ts', startLine: 1, endLine: 1, patch: '+export const component = () => shared();' };
const MODULES: readonly ArchitectureModule[] = [
  { path: 'src/component.ts', purpose: 'Component', exports: ['component'] },
  { path: 'far/away/unrelated-name.ts', purpose: 'Other subsystem', exports: ['somethingElse'] },
];

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'malt-component-'));
  const files = new Map([
    ['src/component.ts', `import { shared } from '../library/shared';\nexport const component = () => shared();\n${'\n'.repeat(180)}component(); // late caller`],
    ['library/shared.ts', 'export function shared() { return 42; }'],
    ['far/away/caller.test.ts', "import { component } from '../../src/component';\ncomponent();"],
    ['far/away/unrelated-name.ts', 'export const somethingElse = 7;'],
    ['far/away/duplicate.ts', 'export const component = () => 42;'],
    ['node_modules/hidden.ts', 'const forbiddenDependency = 1;'],
    ['.private/hidden.ts', 'const forbiddenPrivate = 1;'],
    ['src/.env', 'SECRET=never-read'],
  ]);
  for (const [path, content] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
};

export const tests: readonly TestCase[] = [
  {
    name: 'component reviews include distant callers, shared implementations and whole changed files',
    run: async (): Promise<void> => {
      const root = await fixture();
      const context = await collectComponentContext(root, [BLOCK], MODULES);
      const window = await readFileWindow(root, BLOCK.filePath, BLOCK);
      assert.ok(!window.text.includes('late caller'));
      assert.ok(context.files.find((file) => file.path === BLOCK.filePath)?.content.includes('late caller') === true);
      assert.ok(context.files.some((file) => file.path === 'library/shared.ts' && file.content.includes('return 42')));
      assert.ok(context.files.some((file) => file.path === 'far/away/caller.test.ts'));
      assert.ok(context.files.some((file) => file.path === 'far/away/duplicate.ts'));
      assert.ok(context.inventory.includes('far/away/unrelated-name.ts'));
      assert.ok(context.searched.includes('far/away/unrelated-name.ts'));
      assert.ok(context.omittedSources.includes('far/away/unrelated-name.ts'));
      assert.deepEqual(context.unsearched, []);
      assert.deepEqual(context.omittedDirectories, []);
      assert.ok(!JSON.stringify(context).includes('forbidden'));
      assert.ok(!context.inventory.some((path) => path.includes('.env') || path.includes('node_modules') || path.includes('.private')));
    },
  },
  {
    name: 'component context rejects missing primary files and records oversized supporting files',
    run: async (): Promise<void> => {
      const root = await fixture();
      await writeFile(join(root, 'library', 'huge.ts'), 'x'.repeat(2_000_001));
      const context = await collectComponentContext(root, [BLOCK], MODULES);
      assert.ok(context.unsearched.includes('library/huge.ts'));
      assert.ok(context.omittedSources.includes('library/huge.ts'));
      await assert.rejects(collectComponentContext(root, [{ ...BLOCK, filePath: 'src/missing.ts' }], MODULES), /complete source files/u);
      await assert.rejects(collectComponentContext(root, [{ ...BLOCK, filePath: '../outside.ts' }], MODULES), /complete source files/u);
    },
  },
  {
    name: 'a changed documentation file never blocks the component review of the source files beside it',
    run: async (): Promise<void> => {
      const root = await fixture();
      await writeFile(join(root, 'README.md'), '```ts\nconst example = 42;\n```\n');
      const readme: ReviewRequest = { filePath: 'README.md', startLine: 1, endLine: 1, patch: '+const example = 42;' };
      const context = await collectComponentContext(root, [BLOCK, readme], MODULES);
      assert.ok(context.files.some((file) => file.path === BLOCK.filePath), 'the source file is still reviewed');
      assert.ok(!context.files.some((file) => file.path === 'README.md'), 'documentation is not supplied as source');
      await assert.rejects(collectComponentContext(root, [readme, { ...BLOCK, filePath: '.hidden/changed.ts' }], MODULES), /complete source files/u,
        'an excluded code file still fails closed');
    },
  },
  {
    name: 'component prompts preserve rule isolation, full map context and source redaction',
    run: async (): Promise<void> => {
      const root = await fixture();
      const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123';
      await writeFile(join(root, 'library', 'shared.ts'), `export const shared = '${secret}';`);
      const component = await collectComponentContext(root, [BLOCK], MODULES);
      const rule = BASELINE_RULES.find((candidate) => candidate.id === 'reuse-existing');
      assert.ok(rule !== undefined);
      const projectRules = [{ ...rule, id: 'other-project-rule' }];
      const prompt = buildCheckUserPrompt(BLOCK, { firstLine: 1, text: '' }, rule, { projectRules, architecture: MODULES, nonce: 'abc', component });
      assert.ok(prompt.includes('component-context (untrusted json)') && prompt.includes('late caller'));
      assert.ok(prompt.includes('Other subsystem'));
      assert.ok(!prompt.includes('other-project-rule'));
      assert.ok(!prompt.includes(secret));
      const consolidation = buildConsolidationUserPrompt([], MODULES, 'abc', { component, projectRules });
      assert.ok(consolidation.includes('other-project-rule') && consolidation.includes('late caller'));
      assert.ok(BASELINE_RULES.filter(needsComponentContext).some((candidate) => candidate.id === 'no-dead-code'));
      assert.ok(!BASELINE_RULES.filter(needsComponentContext).some((candidate) => candidate.id === 'no-secrets'));
      assert.ok(needsComponentContext({ ...rule, category: 'UI', title: 'Reuse shared components' }));
    },
  },
];
