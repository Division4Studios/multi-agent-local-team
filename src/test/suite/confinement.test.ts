/**
 * Regression tests for the P1 finding: links inside the workspace must not expose files outside it.
 * Directory links use junctions (no admin rights needed on Windows; plain symlinks elsewhere).
 */
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileWindow, readWorkspaceFile } from '../../reviewer/workspace';
import { collectStandardsSources } from '../../reviewer/standardsSources';
import type { TestCase } from './harness';

const SECRET = 'TOP-SECRET-HOST-FILE';

interface Fixture {
  readonly root: string;
}

/** workspace/ with a normal file, a junction to an outside directory, a hard link to an outside file,
 *  and a junction to a directory that is itself inside the workspace. */
const createFixture = async (): Promise<Fixture> => {
  const base = await mkdtemp(join(tmpdir(), 'malt-confine-'));
  const root = join(base, 'workspace');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'secret.md'), `${SECRET}\n`);
  await writeFile(join(outside, 'other-secret.md'), `${SECRET}\n`);
  await writeFile(join(root, 'src', 'a.ts'), 'const a = 1;\n');
  await writeFile(join(root, 'docs', 'guide.md'), '# Guide\nUse camelCase.\n');
  await symlink(outside, join(root, 'escape'), 'junction');
  await symlink(join(root, 'docs'), join(root, 'docs-alias'), 'junction');
  await link(join(outside, 'other-secret.md'), join(root, 'hardlinked.md'));
  return { root };
};

export const tests: readonly TestCase[] = [
  {
    name: 'confinement: reads normal workspace files and in-workspace links',
    run: async (): Promise<void> => {
      const { root } = await createFixture();
      assert.equal(await readWorkspaceFile(root, 'src/a.ts', 1_000), 'const a = 1;\n');
      assert.match((await readWorkspaceFile(root, 'docs-alias/guide.md', 1_000)) ?? '', /camelCase/u);
    },
  },
  {
    name: 'confinement: refuses a link that leads outside the workspace',
    run: async (): Promise<void> => {
      const { root } = await createFixture();
      await assert.rejects(readWorkspaceFile(root, 'escape/secret.md', 1_000), /outside the workspace/u);
      await assert.rejects(readFileWindow(root, 'escape/secret.md', { startLine: 0, endLine: 0 }), /outside the workspace/u);
    },
  },
  {
    name: 'confinement: refuses hard links and non-files',
    run: async (): Promise<void> => {
      const { root } = await createFixture();
      await assert.rejects(readWorkspaceFile(root, 'hardlinked.md', 1_000), /hard-linked/u);
      await assert.rejects(readWorkspaceFile(root, 'src', 1_000));
    },
  },
  {
    name: 'confinement: standards scan never reads linked or outside files',
    run: async (): Promise<void> => {
      const { root } = await createFixture();
      const sources = await collectStandardsSources(root);
      assert.deepEqual(sources.map((source) => source.path), ['docs/guide.md']);
      assert.ok(sources.every((source) => !source.content.includes(SECRET)));
    },
  },
];
