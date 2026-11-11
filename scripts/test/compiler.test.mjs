import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { URL } from 'node:url';
import { isApprovedVersion } from '../dependency-versions.mts';
import { compilerArguments, containerArguments, parseCompilerMode, SOURCE_MOUNTS } from '../compiler-options.mts';

test('dependency policy permits only stable exact compiler aliases to Microsoft packages', () => {
  assert.ok(isApprovedVersion('@typescript/native', 'npm:typescript@7.0.2'));
  assert.ok(isApprovedVersion('typescript', 'npm:@typescript/typescript6@6.0.2'));
  assert.ok(isApprovedVersion('eslint', '10.14.0'));
  for (const [name, version] of [
    ['@typescript/native', 'npm:typescript@^7.0.2'], ['@typescript/native', '7.0.2'],
    ['@typescript/native', 'npm:typescript@7.1.0-beta.1'], ['@typescript/native', 'npm:other@7.0.2'],
    ['typescript', '7.0.2'], ['typescript', 'npm:@typescript/typescript6@latest'],
    ['typescript', 'npm:typescript@6.0.3'], ['eslint', 'npm:eslint@10.14.0'],
  ]) {
    assert.equal(isApprovedVersion(name, version), false, `${name}: ${version}`);
  }
});

test('installed compiler is TypeScript 7 while ESLint resolves the TypeScript 6 API', () => {
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  const native = require('@typescript/native/package.json');
  assert.equal(native.name, 'typescript');
  assert.equal(`npm:typescript@${native.version}`, manifest.devDependencies['@typescript/native']);
  const compatibility = require('typescript/package.json');
  assert.equal(compatibility.name, '@typescript/typescript6');
  assert.equal(`npm:${compatibility.name}@${compatibility.version}`, manifest.devDependencies.typescript);
  const eslintRequire = createRequire(require.resolve('@typescript-eslint/typescript-estree'));
  const typescript = eslintRequire('typescript');
  assert.match(typescript.version, /^6\.0\./u);
  assert.equal(typeof typescript.createProgram, 'function');
});

test('compiler launcher rejects arbitrary commands and confines output', () => {
  for (const invalid of [undefined, '', 'host', '--outDir', 'compile && whoami']) {
    assert.throws(() => parseCompilerMode(invalid));
  }
  // Keep the fixed project/no-emit contract independent of the serial flag's position.
  assert.deepEqual(compilerArguments('check').map(args => args.filter(arg => arg !== '--singleThreaded')),
    [['-p', '.', '--noEmit'], ['-p', 'scripts', '--noEmit']]);
  for (const mode of ['compile', 'watch']) {
    const commands = compilerArguments(mode);
    assert.equal(commands.length, 1);
    const [args] = commands;
    assert.ok(args.includes('-p'));
    assert.equal(args[args.indexOf('-p') + 1], '.');
    assert.ok(args.includes('--noEmitOnError'));
    assert.equal(args.includes('--noEmit'), false);
    assert.equal(args[args.indexOf('--outDir') + 1], '/workspace/out');
    assert.equal(args.includes('--watch'), mode === 'watch');
    assert.equal(args.includes('--preserveWatchOutput'), mode === 'watch');
  }
});

for (const [mode, index, invocation] of [
  ['check', 0, 'source check'], ['check', 1, 'scripts check'],
  ['compile', 0, 'compile'], ['watch', 0, 'watch'],
]) {
  test(`compiler launcher serializes file reads for ${invocation}`, () => {
    const args = compilerArguments(mode)[index];
    assert.ok(args !== undefined, `${invocation} invocation must exist`);
    assert.equal(args.filter(arg => arg === '--singleThreaded').length, 1,
      `${invocation} must enable --singleThreaded; checker/CPU limits do not serialize file reads`);
    assert.notEqual(args[args.indexOf('--singleThreaded') + 1], 'false');
  });
}

test('compiler launcher preserves version and sandbox probe entry contracts', () => {
  assert.deepEqual(compilerArguments('version'), [['--version']]);
  assert.deepEqual(compilerArguments('sandbox-test'), [['/workspace/scripts/test/compiler-probe.mjs']]);
});

test('container security restrictions cannot be replaced by source paths', () => {
  const mount = 'type=bind,source=C:\\work with spaces\\src,target=/workspace/src,readonly';
  const args = containerArguments('fixture', '1000:1000', [mount]);
  for (const option of ['--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=2g', '--memory-swap=2g', '--cpus=2']) {
    assert.ok(args.includes(option), option);
  }
  assert.equal(args[args.indexOf('--mount') + 1], mount);
  assert.deepEqual(SOURCE_MOUNTS, ['src', 'scripts', 'tsconfig.json', 'tsconfig.base.json']);
});
