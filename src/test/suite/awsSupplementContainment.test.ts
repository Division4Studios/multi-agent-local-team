import assert from 'node:assert/strict';
import { link, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestCase } from './harness';
import { withInjection } from './awsSupplementInjectionFixture';
import { createFileSymlink, assertFileSymlinkRetained } from './awsSupplementOracles';
import { observe, rejected } from './awsAsyncFixture';

export const tests: readonly TestCase[] = [
  {
    name: 'AWS supplement injection containment: malformed origins and signing regions never write or publish',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        const endpoints = ['', 'https://127.0.0.1:4566', 'http://user:password@127.0.0.1:4566',
          'http://127.0.0.1:4566/path', 'http://127.0.0.1:4566?query=1', 'http://127.0.0.1:4566#fragment', 'http://127.0.0.1:65536'];
        const targets = [
          ...endpoints.map(endpoint => ({ ...f.target, endpoint })),
          ...['', 'bad_region', 'us east 1', 'us-east-1\naws_access_key_id=secret'].map(region => ({ ...f.target, region })),
        ];
        for (const target of targets) { await assert.rejects(f.update(target)); }
        assert.deepEqual(await readdir(f.state), []);
        assert.equal(f.collection.values.size, 0);
        assert.equal(f.collection.replacements.length, 0);
      });
    },
  },
  {
    name: 'AWS supplement injection containment: state must be an absolute directory strictly inside the real workspace',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        await writeFile(join(f.outside, 'sentinel'), 'outside bytes');
        for (const stateDirectory of ['.malt/aws', f.workspace, f.outside, join(f.workspace, '..', 'outside')]) {
          await assert.rejects(f.update({ ...f.target, stateDirectory }));
        }
        assert.equal(await readFile(join(f.outside, 'sentinel'), 'utf8'), 'outside bytes');
        assert.deepEqual(await readdir(f.outside), ['sentinel']);
        assert.deepEqual(await readdir(f.state), []);
        assert.equal(f.collection.values.size, 0);
      });
    },
  },
  {
    name: 'AWS supplement injection containment: linked state ancestors are refused even when they point inside',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        const kind = process.platform === 'win32' ? 'junction' : 'dir';
        await symlink(f.outside, join(f.workspace, 'escape'), kind);
        await symlink(f.state, join(f.workspace, 'inside-alias'), kind);
        for (const stateDirectory of [join(f.workspace, 'escape'), join(f.workspace, 'inside-alias')]) {
          await assert.rejects(f.update({ ...f.target, stateDirectory }));
        }
        assert.deepEqual(await readdir(f.outside), []);
        assert.deepEqual(await readdir(f.state), []);
        assert.equal(f.collection.replacements.length, 0);
      });
    },
  },
  {
    name: 'AWS supplement injection containment: a linked or nonregular fixed profile destination is refused without replacement',
    run: async (): Promise<void> => {
      for (const linked of [false, true]) {
        await withInjection(async f => {
          if (linked) {
            await symlink(f.outside, f.profile, process.platform === 'win32' ? 'junction' : 'dir');
          } else {
            await mkdir(f.profile);
          }
          await writeFile(join(f.outside, 'sentinel'), 'outside bytes');
          await assert.rejects(f.update(f.target));
          assert.equal((await lstat(f.profile)).isSymbolicLink(), linked);
          assert.deepEqual(await readdir(f.outside), ['sentinel']);
          assert.equal(await readFile(join(f.outside, 'sentinel'), 'utf8'), 'outside bytes');
          assert.equal(f.collection.values.size, 0);
        });
      }
    },
  },
  {
    name: 'AWS supplement injection containment: a hardlinked profile is refused and both names retain the original bytes',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        const outside = join(f.outside, 'user-credentials');
        const bytes = Buffer.from('[default]\naws_secret_access_key = OWNED-TEST-SECRET\n');
        await writeFile(outside, bytes);
        await link(outside, f.profile);
        assert.ok((await lstat(f.profile)).nlink > 1);
        await assert.rejects(f.update(f.target));
        assert.deepEqual(await readFile(outside), bytes);
        assert.deepEqual(await readFile(f.profile), bytes);
        assert.ok((await lstat(f.profile)).nlink > 1, 'refusal must not replace the hardlink with a new file');
        assert.equal(f.collection.values.size, 0);
      });
    },
  },
  {
    name: 'AWS supplement injection containment: file-symlink destinations retain inside/outside regular targets and link identity',
    run: async (): Promise<void> => {
      for (const outside of [false, true]) {
        await withInjection(async f => {
          const target = join(outside ? f.outside : f.workspace, 'protected-credentials.ini');
          const before = await createFileSymlink(f.profile, target, Buffer.from('[default]\naws_secret_access_key = OWNED-SYMLINK-SENTINEL\n'));
          await rejected(observe(f.update(f.target)));
          await assertFileSymlinkRetained(before);
          assert.equal(f.collection.replacements.length, 0, 'refusal precedes all environment replacements');
          assert.equal(f.collection.values.size, 0);
        });
      }
    },
  },
];
