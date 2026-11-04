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
  assert.deepEqual(compilerArguments('check'), [['-p', '.', '--noEmit'], ['-p', 'scripts', '--noEmit']]);
  assert.deepEqual(compilerArguments('version'), [['--version']]);
  for (const mode of ['compile', 'watch']) {
    const [args] = compilerArguments(mode);
    assert.ok(args.includes('--noEmitOnError'));
    assert.equal(args[args.indexOf('--outDir') + 1], '/workspace/out');
  }
});

test('container security restrictions cannot be replaced by source paths', () => {
  const mount = 'type=bind,source=C:\\work with spaces\\src,target=/workspace/src,readonly';
  const args = containerArguments('fixture', '1000:1000', [mount]);
  for (const option of ['--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=128', '--memory=2g', '--memory-swap=2g']) {
    assert.ok(args.includes(option), option);
  }
  assert.equal(args[args.indexOf('--mount') + 1], mount);
  assert.deepEqual(SOURCE_MOUNTS, ['src', 'scripts', 'tsconfig.json', 'tsconfig.base.json']);
});
