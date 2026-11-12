import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { TestCase } from './harness';
import { assertProfile, assertTarget, withInjection } from './awsSupplementInjectionFixture';

export const tests: readonly TestCase[] = [
  {
    name: 'AWS supplement injection: construction clears prior mutations and disables persistence immediately',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        assert.equal(f.collection.persistent, false);
        assert.equal(f.collection.values.size, 0);
        assert.ok(f.collection.clears > 0);
        assert.equal(f.collection.replacements.length, 0);
        await assert.rejects(readFile(f.profile));
      });
    },
  },
  {
    name: 'AWS supplement injection: profile write precedes every replacement and the complete environment is exact',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        const profiles: string[] = [];
        f.collection.onReplace = (): void => { profiles.push(readFileSync(f.profile, 'utf8')); };
        await f.update(f.target);
        await assertTarget(f, f.target);
        assert.ok(profiles.length >= 16);
        for (const profile of profiles) { assertProfile(profile, f.target.region); }
      });
    },
  },
  {
    name: 'AWS supplement injection: endpoint/region refresh replaces all old mutations and rewrites a regular profile',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        await writeFile(f.profile, 'previous owned dummy profile');
        await f.update(f.target);
        f.collection.values.set('OLD_SETTING', 'must disappear');
        const next = { ...f.target, endpoint: 'http://127.0.0.1:14567', region: 'ap-southeast-7' };
        await f.update(next);
        await assertTarget(f, next);
      });
    },
  },
  {
    name: 'AWS supplement injection: clear and disposal are immediate, preserve the dummy file, and disposal rejects every update',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        await f.update(f.target);
        const bytes = await readFile(f.profile);
        const clearing = f.update(undefined);
        assert.equal(f.collection.values.size, 0);
        await clearing;
        assert.deepEqual(await readFile(f.profile), bytes);
        await f.update(f.target);
        f.dispose();
        assert.equal(f.collection.values.size, 0);
        await assert.rejects(f.update(f.target));
        await assert.rejects(f.update(undefined));
        assert.equal(f.collection.values.size, 0);
        assert.deepEqual(await readFile(f.profile), bytes);
      });
    },
  },
  {
    name: 'AWS supplement injection: current validation failure rejects and clears a previously active collection',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        await f.update(f.target);
        const bytes = await readFile(f.profile);
        await assert.rejects(f.update({ ...f.target, region: 'us-east-1\n[profile injected]' }));
        assert.equal(f.collection.values.size, 0);
        assert.deepEqual(await readFile(f.profile), bytes);
      });
    },
  },
  {
    name: 'AWS supplement injection: configured user AWS files retain their bytes and cannot supply profile credentials',
    run: async (): Promise<void> => {
      await withInjection(async f => {
        const config = join(f.outside, 'config');
        const credentials = join(f.outside, 'credentials');
        const sentinel = '[default]\naws_access_key_id = USER-SECRET-MARKER\n';
        await writeFile(config, sentinel);
        await writeFile(credentials, sentinel);
        const previousConfig = process.env['AWS_CONFIG_FILE'];
        const previousCredentials = process.env['AWS_SHARED_CREDENTIALS_FILE'];
        try {
          process.env['AWS_CONFIG_FILE'] = config;
          process.env['AWS_SHARED_CREDENTIALS_FILE'] = credentials;
          await f.update(f.target);
          await assertTarget(f, f.target);
          assert.equal(await readFile(config, 'utf8'), sentinel);
          assert.equal(await readFile(credentials, 'utf8'), sentinel);
        } finally {
          restore('AWS_CONFIG_FILE', previousConfig);
          restore('AWS_SHARED_CREDENTIALS_FILE', previousCredentials);
        }
      });
    },
  },
];

function restore(name: string, value: string | undefined): void {
  if (value === undefined) { Reflect.deleteProperty(process.env, name); } else { process.env[name] = value; }
}
