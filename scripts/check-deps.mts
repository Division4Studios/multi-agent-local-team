/**
 * Dependency policy guard. Runs with plain Node (type stripping), no extra packages.
 *
 * Fails if package.json:
 * - declares runtime `dependencies` (the extension ships with zero),
 * - declares a devDependency outside the approved allowlist,
 * - uses a non-exact version (ranges, tags, URLs, git refs),
 * - declares unreviewed overrides, resolutions, optional or peer dependencies,
 * or if package-lock.json is missing or contains affected minimatch versions.
 *
 * Changing the allowlist is a policy change: it requires a maintainer-approved PR.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkMinimatchLockfile, checkSecurityOverrides } from './security-overrides.mts';
import { isApprovedVersion } from './dependency-versions.mts';

const ALLOWED_DEV_DEPENDENCIES: ReadonlySet<string> = new Set([
  '@eslint/js',
  '@types/node',
  '@types/vscode',
  '@typescript/native',
  '@vscode/test-electron',
  '@vscode/vsce',
  'eslint',
  'typescript',
  'typescript-eslint',
]);

const FORBIDDEN_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
  'resolutions',
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const root = join(import.meta.dirname, '..');
const parsed: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!isRecord(parsed)) {
  throw new Error('package.json is not a JSON object');
}

const problems: string[] = checkSecurityOverrides(parsed['overrides']);

for (const field of FORBIDDEN_FIELDS) {
  const value = parsed[field];
  if (isRecord(value) && Object.keys(value).length > 0) {
    problems.push(`"${field}" is not allowed in package.json`);
  }
}

const devDependencies = parsed['devDependencies'];
if (isRecord(devDependencies)) {
  for (const [name, version] of Object.entries(devDependencies)) {
    if (!ALLOWED_DEV_DEPENDENCIES.has(name)) {
      problems.push(`devDependency "${name}" is not on the approved allowlist`);
    }
    if (!isApprovedVersion(name, version)) {
      problems.push(`devDependency "${name}" must be pinned to an exact version (got ${JSON.stringify(version)})`);
    }
  }
}

if (!existsSync(join(root, 'package-lock.json'))) {
  problems.push('package-lock.json is missing');
} else {
  const lockfile: unknown = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  problems.push(...checkMinimatchLockfile(lockfile));
}

if (problems.length > 0) {
  console.error('Dependency policy violations:');
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  process.exit(1);
}

console.log('Dependency policy OK.');
