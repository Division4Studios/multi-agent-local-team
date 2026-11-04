import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { ESLint } from 'eslint';
import { listFiles, PackageManager } from '@vscode/vsce';
import { checkMinimatchLockfile } from '../security-overrides.mts';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'malt-toolchain-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return root;
}

test('ESLint selects nested and hidden sources, honors exclusions and negations, and enforces rules', async t => {
  const sources = ['src/main.mjs', 'src/deep/child.mjs', 'src/.hidden.mjs',
    'ignored/drop.mjs', 'ignored/keep.mjs', 'out/generated.mjs', 'node_modules/pkg/index.mjs'];
  const cwd = await fixture(t, Object.fromEntries(sources.map(path => [path, '// eslint-disable-next-line\ndebugger;\n'])));
  const eslint = new ESLint({ cwd, overrideConfigFile: true, overrideConfig: [
    { ignores: ['out/**', 'ignored/*', '!ignored/keep.mjs'] },
    { files: ['**/*.mjs'], linterOptions: { noInlineConfig: true }, rules: { 'no-debugger': 'error' } },
  ] });
  const results = await eslint.lintFiles(['.']);
  const selected = results.map(result => relative(cwd, result.filePath).replaceAll('\\', '/')).sort();
  assert.deepEqual(selected, ['ignored/keep.mjs', 'src/.hidden.mjs', 'src/deep/child.mjs', 'src/main.mjs']);
  for (const result of results) {
    assert.equal(result.errorCount, 1, result.filePath);
    assert.ok(result.messages.some(message => message.ruleId === 'no-debugger'));
  }
});

test('VSCE allowlist includes intended dotfiles but excludes credentials, dependencies, and tests', async t => {
  const cwd = await fixture(t, {
    'package.json': JSON.stringify({ name: 'malt-fixture', version: '0.0.1', publisher: 'malt',
      engines: { vscode: '^1.144.0' } }),
    '.vscodeignore': '**\n!package.json\n!README.md\n!out/**/*.js\n!docs/**\n',
    'README.md': '# Fixture',
    'out/main.js': '', 'out/nested/worker.js': '', 'out/main.js.map': '',
    'docs/guide.md': '', 'docs/.included': '',
    '.env': 'FAKE_TEST_CREDENTIAL=fixture', '.malt/standards.json': '{}',
    'src/test/test.ts': '', 'node_modules/fake/index.js': '',
  });
  const selected = await listFiles({ cwd, packageManager: PackageManager.None });
  assert.deepEqual(selected.map(path => path.replaceAll('\\', '/')).sort(),
    ['README.md', 'docs/.included', 'docs/guide.md', 'out/main.js', 'out/nested/worker.js', 'package.json']);
});

test('real VSIX file selection includes required assets and excludes development-only files', async () => {
  const files = (await listFiles({ packageManager: PackageManager.None })).map(path => path.replaceAll('\\', '/'));
  for (const expected of ['package.json', 'README.md', 'LICENSE', 'media/icon.png']) {
    assert.ok(files.includes(expected), expected);
  }
  for (const file of files) {
    assert.doesNotMatch(file, /(^|\/)(node_modules|src|scripts|test|\.malt|\.github|\.vscode-test)(\/|$)/u);
    assert.doesNotMatch(file, /(^|\/)\.env(?:\.|$)|\.map$|package-lock\.json$/u);
  }
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(manifest.dependencies, undefined);
});

test('every affected parent resolves a patched matcher with Windows path support', () => {
  const require = createRequire(import.meta.url);
  for (const parent of ['eslint', '@eslint/config-array', '@typescript-eslint/typescript-estree', '@vscode/vsce']) {
    const parentRequire = createRequire(require.resolve(parent));
    const { minimatch, Minimatch } = parentRequire('minimatch');
    const { version } = parentRequire('minimatch/package.json');
    assert.deepEqual(checkMinimatchLockfile({ lockfileVersion: 3,
      packages: { 'node_modules/minimatch': { version } } }), [], parent);
    assert.equal(minimatch('C:\\work\\src\\main.ts', 'C:/work/src/**/*.ts',
      { platform: 'win32', windowsPathsNoEscape: true }), true, parent);
    assert.equal(minimatch('//server/share/src/main.ts', '//SERVER/SHARE/src/**/*.ts',
      { platform: 'win32' }), true, parent);
    assert.equal(minimatch('src/.hidden.ts', 'src/**/*.ts', { dot: true }), true, parent);
    assert.equal(minimatch('src/main.ts', 'src/**/*.js'), false, parent);
    const matcher = new Minimatch('src/**/file.ts', { dot: true });
    assert.equal(matcher.match('src/deep', true), true, parent);
    assert.equal(matcher.match('other/deep', true), false, parent);
  }
});
