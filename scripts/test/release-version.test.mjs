import assert from 'node:assert/strict';
import { test } from 'node:test';
import { absoluteLinks, bumpLockfile, bumpPackageJson, checkRelease, nextVersion, releaseChangelog } from '../release-version.mts';

const manifest = (version) => `{\n  "name": "malt",\n  "version": "${version}",\n  "repository": { "type": "git", "url": "https://github.com/Owner/repo.git" },\n  "contributes": { "x": [{ "version": "${version}" }] },\n  "devDependencies": {\n    "eslint": "10.0.0"\n  }\n}\n`;
const lockfile = (version, dependencyVersion = '10.0.0') => `{\n  "name": "malt",\n  "version": "${version}",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "malt",\n      "version": "${version}"\n    },\n    "node_modules/eslint": {\n      "version": "${dependencyVersion}"\n    }\n  }\n}\n`;
const CHANGELOG = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Releases. [Guide](docs/releasing.md)\n\n## [0.9.0] - 2026-01-01\n\n- Older.\n';

test('versions increment major, minor or patch and reset the lower parts', () => {
  assert.equal(nextVersion('0.0.1', 'major'), '1.0.0');
  assert.equal(nextVersion('1.4.2', 'minor'), '1.5.0');
  assert.equal(nextVersion('1.4.9', 'patch'), '1.4.10');
  for (const invalid of ['1.0', 'v1.0.0', '01.0.0', '1.0.0-rc.1', '']) {
    assert.throws(() => nextVersion(invalid, 'patch'), /MAJOR\.MINOR\.PATCH/u, invalid);
  }
});

test('a bump changes only the version lines and keeps formatting and line endings', () => {
  assert.equal(bumpPackageJson(manifest('0.0.1'), '0.0.1', '1.0.0'), manifest('1.0.0').replace('"x": [{ "version": "1.0.0" }]', '"x": [{ "version": "0.0.1" }]'),
    'a nested "version" is not the package version');
  assert.equal(bumpLockfile(lockfile('0.0.1', '0.0.1'), '0.0.1', '1.0.0'), lockfile('1.0.0', '0.0.1'), 'a dependency at the same version is untouched');
  const crlf = lockfile('0.0.1').replaceAll('\n', '\r\n');
  assert.equal(bumpLockfile(crlf, '0.0.1', '1.0.0'), lockfile('1.0.0').replaceAll('\n', '\r\n'));
  assert.throws(() => bumpPackageJson(manifest('0.0.2'), '0.0.1', '1.0.0'), /found 0/u);
  assert.throws(() => bumpLockfile(lockfile('0.0.1').replace('      "version": "0.0.1"', '      "version": "0.0.9"'), '0.0.1', '1.0.0'), /packages\[""\] version "0\.0\.1", found 0/u);
  const sameAsDependency = lockfile('1.0.0', '1.0.0');
  assert.equal(bumpLockfile(sameAsDependency, '1.0.0', '1.0.1'), lockfile('1.0.1', '1.0.0'), 'only the root entry moves, never a dependency at the same version');
});

test('the changelog moves Unreleased notes under a dated release section once', () => {
  const released = releaseChangelog(CHANGELOG, '1.0.0', '2026-11-05');
  assert.equal(released, CHANGELOG.replace('## [Unreleased]\n', '## [Unreleased]\n\n## [1.0.0] - 2026-11-05\n'));
  assert.throws(() => releaseChangelog(released, '1.0.0', '2026-11-05'), /already has a section/u);
  assert.throws(() => releaseChangelog(released, '1.0.1', '2026-11-05'), /nothing under/u, 'an empty Unreleased section is not a release');
  assert.throws(() => releaseChangelog(CHANGELOG, '1.0.0', 'today'), /YYYY-MM-DD/u);
});

test('a release tag must match package.json, both lockfile fields and a dated changelog section', () => {
  const files = { packageJson: manifest('1.0.0'), lockfile: lockfile('1.0.0'), changelog: releaseChangelog(CHANGELOG, '1.0.0', '2026-11-05') };
  assert.deepEqual(checkRelease('v1.0.0', files), { problems: [], notes: '### Added\n\n- Releases. [Guide](https://github.com/Owner/repo/blob/v1.0.0/docs/releasing.md)' },
    'relative links point at the release tag');
  const unlinked = { ...files, packageJson: manifest('1.0.0').replace(/ {2}"repository": .*\n/u, '') };
  assert.deepEqual(checkRelease('v1.0.0', unlinked).problems, ['package.json has no repository.url']);
  assert.deepEqual(checkRelease('1.0.0', files).problems, ['Tag "1.0.0" is not vMAJOR.MINOR.PATCH']);
  assert.deepEqual(checkRelease('v1.0.0-rc.1', files).problems, ['Tag "v1.0.0-rc.1" is not vMAJOR.MINOR.PATCH']);
  assert.deepEqual(checkRelease('v1.0.1', files).problems, [
    'package.json has version "1.0.0", but the tag is v1.0.1',
    'package-lock.json has version "1.0.0", but the tag is v1.0.1',
    'package-lock.json packages[""] has version "1.0.0", but the tag is v1.0.1',
    'CHANGELOG.md needs a "## [1.0.1] - YYYY-MM-DD" section',
  ]);
  const stale = { ...files, lockfile: lockfile('1.0.0').replace('      "version": "1.0.0"', '      "version": "0.0.1"') };
  assert.deepEqual(checkRelease('v1.0.0', stale).problems, ['package-lock.json packages[""] has version "0.0.1", but the tag is v1.0.0']);
  const undated = { ...files, changelog: files.changelog.replace('## [1.0.0] - 2026-11-05', '## [1.0.0]') };
  assert.deepEqual(checkRelease('v1.0.0', undated).problems, ['CHANGELOG.md needs a "## [1.0.0] - YYYY-MM-DD" section']);
  const empty = { ...files, changelog: '## [Unreleased]\n\n## [1.0.0] - 2026-11-05\n\n## [0.9.0] - 2026-01-01\n- Older.\n' };
  assert.deepEqual(checkRelease('v1.0.0', empty).problems, ['CHANGELOG.md section 1.0.0 is empty']);
});

test('release notes link to files at the release tag; absolute links and anchors are unchanged', () => {
  const notes = '[a](docs/a.md) [b](https://x.test/b) [c](#c) [d](mailto:d@x.test) [e](/root.md) [f](../f.md)';
  assert.equal(absoluteLinks(notes, 'https://github.com/Owner/repo.git', 'v1.2.3'),
    '[a](https://github.com/Owner/repo/blob/v1.2.3/docs/a.md) [b](https://x.test/b) [c](#c) [d](mailto:d@x.test) [e](/root.md) [f](https://github.com/Owner/repo/blob/v1.2.3/../f.md)');
  assert.equal(absoluteLinks('[a](a.md)', 'https://github.com/Owner/repo', 'v1.0.0'), '[a](https://github.com/Owner/repo/blob/v1.0.0/a.md)');
  assert.throws(() => absoluteLinks('', 'https://evil.test/Owner/repo.git', 'v1.0.0'), /Not a GitHub repository URL/u);
});
