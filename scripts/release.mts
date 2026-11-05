/**
 * Release helper. Runs with plain Node (type stripping), no extra packages.
 *
 *   node scripts/release.mts bump <major|minor|patch>   Prepares the next version on a release branch: sets it in
 *                                                       package.json and package-lock.json, and moves the
 *                                                       Unreleased changelog notes under a dated section for it.
 *   node scripts/release.mts check <tag> <notes-file>   Used by the release workflow: fails unless the tag matches
 *                                                       the version everywhere, then writes that section's notes.
 *
 * See docs/releasing.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bumpLockfile, bumpPackageJson, checkRelease, isBump, nextVersion, releaseChangelog } from './release-version.mts';

const root = join(import.meta.dirname, '..');
const paths = {
  packageJson: join(root, 'package.json'),
  lockfile: join(root, 'package-lock.json'),
  changelog: join(root, 'CHANGELOG.md'),
};
const read = (path: string): string => readFileSync(path, 'utf8');

const currentVersion = (): string => {
  const manifest: unknown = JSON.parse(read(paths.packageJson));
  const version: unknown = typeof manifest === 'object' && manifest !== null && 'version' in manifest ? manifest.version : undefined;
  if (typeof version !== 'string') {
    throw new Error('package.json has no version');
  }
  return version;
};

const bump = (kind: string | undefined): void => {
  if (!isBump(kind)) {
    throw new Error('Usage: node scripts/release.mts bump <major|minor|patch>');
  }
  const from = currentVersion();
  const to = nextVersion(from, kind);
  // Compute every edit before writing any, so a refusal leaves all three files untouched.
  const files = {
    packageJson: bumpPackageJson(read(paths.packageJson), from, to),
    lockfile: bumpLockfile(read(paths.lockfile), from, to),
    changelog: releaseChangelog(read(paths.changelog), to, new Date().toISOString().slice(0, 10)),
  };
  writeFileSync(paths.packageJson, files.packageJson);
  writeFileSync(paths.lockfile, files.lockfile);
  writeFileSync(paths.changelog, files.changelog);
  console.log(`${from} -> ${to}. Review CHANGELOG.md, then open a pull request to dev titled "release: v${to}".`);
};

const check = (tag: string | undefined, notesPath: string | undefined): void => {
  if (tag === undefined || notesPath === undefined) {
    throw new Error('Usage: node scripts/release.mts check <tag> <notes-file>');
  }
  const { problems, notes } = checkRelease(tag, { packageJson: read(paths.packageJson), lockfile: read(paths.lockfile), changelog: read(paths.changelog) });
  if (problems.length > 0) {
    console.error(`Release ${tag} does not match the repository:`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  writeFileSync(notesPath, `${notes}\n`);
  console.log(`Release ${tag} matches package.json, package-lock.json and CHANGELOG.md.`);
};

const [command, first, second] = process.argv.slice(2);
try {
  if (command === 'bump') {
    bump(first);
  } else if (command === 'check') {
    check(first, second);
  } else {
    throw new Error('Usage: node scripts/release.mts <bump|check> ...');
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
