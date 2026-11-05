/**
 * Release versioning. A release has one MAJOR.MINOR.PATCH version, written in exactly three places: package.json,
 * package-lock.json (its root and its `packages[""]` entry) and a `## [X.Y.Z] - YYYY-MM-DD` section of CHANGELOG.md.
 *
 * Edits are textual, so a bump changes those lines and nothing else (no reformatting), and every edit is checked by
 * parsing the result: apart from the version fields, the parsed file must be identical to the original.
 */
export type Bump = 'major' | 'minor' | 'patch';

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const UNRELEASED = '## [Unreleased]';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isBump = (value: unknown): value is Bump => value === 'major' || value === 'minor' || value === 'patch';

export const nextVersion = (current: string, bump: Bump): string => {
  const match = VERSION.exec(current);
  if (match === null) {
    throw new Error(`Not a MAJOR.MINOR.PATCH version: ${current}`);
  }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (bump === 'major') {
    return `${String(major + 1)}.0.0`;
  }
  return bump === 'minor' ? `${String(major)}.${String(minor + 1)}.0` : `${String(major)}.${String(minor)}.${String(patch + 1)}`;
};

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Where a version is written: the text before its value (one capture group), and a name for errors. */
interface VersionField {
  readonly prefix: string;
  readonly label: string;
}

/** The top-level `"version"` line of package.json or package-lock.json (two-space indent). */
const PACKAGE_VERSION: VersionField = { prefix: '^( {2}"version": )', label: 'package.json' };
const LOCK_VERSION: VersionField = { prefix: PACKAGE_VERSION.prefix, label: 'package-lock.json' };
/**
 * The lockfile's root package entry, `packages[""]`, whose name and version come first. Matching the entry itself
 * matters: dependencies at the same indent often have the same version number.
 */
const LOCK_ROOT_VERSION: VersionField = {
  prefix: '^( {4}"": \\{\\r?\\n {6}"name": "[^"\\r\\n]*",\\r?\\n {6}"version": )',
  label: 'package-lock.json packages[""]',
};

/** Replaces the one version written at `field`. Throws unless there is exactly one. */
const replaceVersion = (text: string, field: VersionField, from: string, to: string): string => {
  const pattern = new RegExp(`${field.prefix}"${escaped(from)}"`, 'gmu');
  const count = text.match(pattern)?.length ?? 0;
  if (count !== 1) {
    throw new Error(`Expected one ${field.label} version "${from}", found ${String(count)}`);
  }
  return text.replace(pattern, `$1"${to}"`);
};

/** Fails unless `after` parses to `before` with only the given version fields changed to `to`. */
const assertOnlyVersions = (before: string, after: string, to: string, setVersions: (parsed: Record<string, unknown>) => void): void => {
  const expected: unknown = JSON.parse(before);
  if (!isRecord(expected)) {
    throw new Error('Expected a JSON object');
  }
  setVersions(expected);
  if (JSON.stringify(expected) !== JSON.stringify(JSON.parse(after))) {
    throw new Error(`Setting version ${to} would change more than the version fields`);
  }
};

export const bumpPackageJson = (text: string, from: string, to: string): string => {
  const result = replaceVersion(text, PACKAGE_VERSION, from, to);
  assertOnlyVersions(text, result, to, (parsed) => {
    parsed['version'] = to;
  });
  return result;
};

export const bumpLockfile = (text: string, from: string, to: string): string => {
  const result = replaceVersion(replaceVersion(text, LOCK_VERSION, from, to), LOCK_ROOT_VERSION, from, to);
  assertOnlyVersions(text, result, to, (parsed) => {
    parsed['version'] = to;
    const packages = parsed['packages'];
    const root = isRecord(packages) ? packages[''] : undefined;
    if (!isRecord(root)) {
      throw new Error('package-lock.json has no root package entry');
    }
    root['version'] = to;
  });
  return result;
};

/** The body of the section whose heading line starts with `heading`, up to the next `## [` heading. */
const sectionBody = (changelog: string, heading: string): string | undefined => {
  const lines = changelog.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start === -1) {
    return undefined;
  }
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## ['));
  return lines.slice(start + 1, next === -1 ? undefined : next).join('\n').trim();
};

/** Starts the release section: what is under Unreleased moves under `## [version] - date`, and Unreleased is emptied. */
export const releaseChangelog = (changelog: string, version: string, date: string): string => {
  if (!DATE.test(date)) {
    throw new Error(`Not a YYYY-MM-DD date: ${date}`);
  }
  if (sectionBody(changelog, `## [${version}]`) !== undefined) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  const unreleased = sectionBody(changelog, UNRELEASED);
  if (unreleased === undefined || unreleased === '') {
    throw new Error('CHANGELOG.md has nothing under "## [Unreleased]" to release');
  }
  const newline = changelog.includes('\r\n') ? '\r\n' : '\n';
  return changelog.replace(UNRELEASED, `${UNRELEASED}${newline}${newline}## [${version}] - ${date}`);
};

/**
 * Points the changelog's relative Markdown links (`[text](docs/x.md)`) at the files as they are at the release tag,
 * so they work on the release page. Absolute URLs, anchors and mailto links are left as they are.
 */
export const absoluteLinks = (notes: string, repositoryUrl: string, tag: string): string => {
  const repository = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(repositoryUrl)?.[1];
  if (repository === undefined) {
    throw new Error(`Not a GitHub repository URL: ${repositoryUrl}`);
  }
  return notes.replace(/\]\((?![a-z][a-z\d+.-]*:|#|\/)([^)\s]+)\)/giu, `](https://github.com/${repository}/blob/${tag}/$1)`);
};

export interface ReleaseFiles {
  readonly packageJson: string;
  readonly lockfile: string;
  readonly changelog: string;
}

/** A field of a parsed JSON object, or undefined; `path` walks nested objects. */
const field = (value: unknown, ...path: readonly string[]): unknown =>
  path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value);

/** Where each file records the version, and whether it is `version`. */
const versionProblems = (version: string, tag: string, files: ReleaseFiles): string[] => {
  const lockfile: unknown = JSON.parse(files.lockfile);
  const found: Readonly<Record<string, unknown>> = {
    'package.json': field(JSON.parse(files.packageJson), 'version'),
    'package-lock.json': field(lockfile, 'version'),
    'package-lock.json packages[""]': field(lockfile, 'packages', '', 'version'),
  };
  return Object.entries(found).filter(([, value]) => value !== version)
    .map(([where, value]) => `${where} has version ${JSON.stringify(value)}, but the tag is ${tag}`);
};

/** The dated changelog section for `version`: a problem, or its notes. */
const changelogSection = (version: string, changelog: string): { readonly problem?: string; readonly notes: string } => {
  const dated = new RegExp(`^## \\[${escaped(version)}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'u');
  const heading = changelog.split(/\r?\n/u).find((line) => line.startsWith(`## [${version}]`));
  if (heading === undefined || !dated.test(heading)) {
    return { problem: `CHANGELOG.md needs a "## [${version}] - YYYY-MM-DD" section`, notes: '' };
  }
  const notes = sectionBody(changelog, `## [${version}]`) ?? '';
  return notes === '' ? { problem: `CHANGELOG.md section ${version} is empty`, notes } : { notes };
};

/**
 * Checks that a release tag matches the repository: the tag is `v` plus the version in package.json and in both
 * lockfile fields, and CHANGELOG.md has a dated, non-empty section for it. Returns the problems, or the release
 * notes with relative links pointing at the tag.
 */
export const checkRelease = (tag: string, files: ReleaseFiles): { readonly problems: readonly string[]; readonly notes: string } => {
  const version = tag.startsWith('v') ? tag.slice(1) : '';
  if (!VERSION.test(version)) {
    return { problems: [`Tag ${JSON.stringify(tag)} is not vMAJOR.MINOR.PATCH`], notes: '' };
  }
  const section = changelogSection(version, files.changelog);
  const url = field(JSON.parse(files.packageJson), 'repository', 'url');
  const problems = [
    ...versionProblems(version, tag, files),
    ...(section.problem === undefined ? [] : [section.problem]),
    ...(typeof url === 'string' ? [] : ['package.json has no repository.url']),
  ];
  return { problems, notes: problems.length === 0 && typeof url === 'string' ? absoluteLinks(section.notes, url, tag) : '' };
};
