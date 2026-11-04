/** Temporary, parent-version-scoped fix for GHSA-g3hv-75wg-m249. See SECURITY.md. */
const APPROVED_PARENTS: ReadonlySet<string> = new Set([
  '@vscode/vsce@4.1.0',
  'eslint@10.14.0',
  '@eslint/config-array@0.23.5',
  '@typescript-eslint/typescript-estree@8.72.1',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Accept only the reviewed exception; absence is allowed once upstream fixes the tree. */
export function checkSecurityOverrides(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return ['overrides must be an object containing only reviewed security exceptions'];
  }
  return Object.entries(value).flatMap(([parent, replacement]) => {
    if (!APPROVED_PARENTS.has(parent) || !isRecord(replacement)
      || Object.keys(replacement).length !== 1 || replacement['minimatch'] !== '11.0.4') {
      return [`Unapproved dependency override: ${parent}`];
    }
    return [];
  });
}

function isPatchedVersion(version: unknown): boolean {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) {
    return false;
  }
  const [major = 0, minor = 0, patch = 0] = version.split('.').map(Number);
  return major > 11 || (major === 11 && (minor > 0 || patch >= 1));
}

/** Check every installed location, including nested copies, against the advisory range. */
export function checkMinimatchLockfile(value: unknown): string[] {
  if (!isRecord(value) || value['lockfileVersion'] !== 3 || !isRecord(value['packages'])) {
    return ['A version 3 lockfile with a packages map is required'];
  }
  return Object.entries(value['packages']).flatMap(([path, entry]) => {
    if (path !== 'node_modules/minimatch' && !path.endsWith('/node_modules/minimatch')) {
      return [];
    }
    if (!isRecord(entry) || !isPatchedVersion(entry['version'])) {
      return [`${path} must resolve to patched minimatch >=11.0.1 (GHSA-g3hv-75wg-m249)`];
    }
    return [];
  });
}
