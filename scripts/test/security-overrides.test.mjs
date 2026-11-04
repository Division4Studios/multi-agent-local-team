import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMinimatchLockfile, checkSecurityOverrides } from '../security-overrides.mts';

test('security exception accepts only exact reviewed parent and child versions', () => {
  const parents = ['@vscode/vsce@4.1.0', 'eslint@10.14.0', '@eslint/config-array@0.23.5',
    '@typescript-eslint/typescript-estree@8.72.1'];
  for (const parent of parents) {
    assert.deepEqual(checkSecurityOverrides({ [parent]: { minimatch: '11.0.4' } }), []);
  }
  assert.deepEqual(checkSecurityOverrides(undefined), []);
  assert.deepEqual(checkSecurityOverrides({}), []);
  for (const invalid of [
    null, [], '11.0.4',
    { minimatch: '11.0.4' },
    { eslint: { minimatch: '11.0.4' } },
    { 'eslint@10.14.1': { minimatch: '11.0.4' } },
    { 'eslint@10.14.0': { minimatch: '^11.0.4' } },
    { 'eslint@10.14.0': { minimatch: '10.2.6' } },
    { 'eslint@10.14.0': { minimatch: '11.0.4', glob: '14.0.0' } },
    { 'eslint@10.14.0': { minimatch: { '.': '11.0.4' } } },
    { 'eslint@10.14.0': '11.0.4' },
  ]) {
    assert.notEqual(checkSecurityOverrides(invalid).length, 0, JSON.stringify(invalid));
  }
});

test('lockfile guard rejects vulnerable and malformed versions at every depth', () => {
  for (const version of ['3.1.5', '10.2.6', '11.0.0', '11.0.1-beta.1', '^11.0.4', undefined]) {
    const lock = { lockfileVersion: 3, packages: {
      'node_modules/minimatch': { version: '11.0.4' },
      'node_modules/tool/node_modules/minimatch': { version },
    } };
    assert.equal(checkMinimatchLockfile(lock).length, 1, String(version));
  }
  for (const version of ['11.0.1', '11.0.4', '11.1.0', '12.0.0']) {
    assert.deepEqual(checkMinimatchLockfile({ lockfileVersion: 3,
      packages: { 'node_modules/minimatch': { version } } }), []);
  }
  for (const invalid of [null, {}, { lockfileVersion: 2, packages: {} },
    { lockfileVersion: 3, packages: [] }]) {
    assert.notEqual(checkMinimatchLockfile(invalid).length, 0);
  }
});
