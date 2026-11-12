import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AwsStartRequest } from '../../cloud/manager';
import type { TestCase } from './harness';
import { TEST_ENDPOINT, withAws } from './awsTestFixtures';
import { drain, fulfilled, observe, rejected } from './awsAsyncFixture';
import { deferred, waitFor } from './testUtils';

const invalidRequests = (request: AwsStartRequest): readonly AwsStartRequest[] => [
  { ...request, trusted: false }, { ...request, workspaceRoot: '' },
  { ...request, port: 0 }, { ...request, port: 65536 }, { ...request, port: 1.5 },
  { ...request, region: 'not_a_signing_region' }, { ...request, bindAddress: 'not an address' },
  ...['', '.', '..', '../outside', join(request.workspaceRoot, 'absolute')].map(stateDirectory => ({ ...request, stateDirectory })),
];

export const tests: readonly TestCase[] = [
  {
    name: 'AWS manager: starts stopped and validates trust, options and containment before invoking a backend',
    run: async (): Promise<void> => {
      await withAws(async f => {
        assert.equal(f.manager.status.state, 'stopped');
        assert.equal(f.manager.status.requestCount, 0);
        assert.equal(f.manager.client, undefined);
        for (const request of invalidRequests(f.request)) {
          await assert.rejects(f.manager.start(request));
        }
        assert.equal(f.host.starts.length + f.docker.starts.length, 0);
        assert.equal(f.clientInputs.length, 0);
        assert.deepEqual(f.calls, [], 'validation precedes even backend availability checks');
      });
    },
  },
  {
    name: 'AWS manager: rejects linked state components and regular files without following them',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const target = join(f.root, 'other-state');
        await mkdir(target);
        await symlink(target, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
        await writeFile(join(f.root, 'not-a-directory'), 'sentinel');
        for (const stateDirectory of ['linked', 'linked/child', 'not-a-directory']) {
          await assert.rejects(f.manager.start({ ...f.request, stateDirectory }));
        }
        assert.equal(f.host.starts.length, 0);
        assert.deepEqual(await readdir(target), []);
      });
    },
  },
  {
    name: 'AWS manager: creates a contained state root, allocates an admin port and publishes only healthy clients',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const states: string[] = [];
        const subscription = f.manager.onDidChangeStatus(status => { states.push(status.state); });
        try {
          await f.manager.start(f.request);
          const options = f.host.starts[0];
          assert.ok(options !== undefined);
          assert.equal(options.stateDirectory, await realpath(join(f.root, '.malt', 'aws')));
          assert.ok((await lstat(options.stateDirectory)).isDirectory());
          assert.ok(Number.isInteger(options.adminPort) && options.adminPort > 0 && options.adminPort <= 65535);
          assert.notEqual(options.adminPort, options.port);
          assert.deepEqual(f.clientInputs, [{ url: TEST_ENDPOINT.adminUrl, token: options.token }]);
          assert.equal(f.manager.status.state, 'running');
          assert.equal(f.manager.status.backend, 'host');
          assert.notEqual(f.manager.status.endpoint, undefined);
          assert.equal(f.manager.status.region, f.request.region);
          assert.equal(f.manager.client, f.api);
          assert.ok(states.includes('starting') && states.includes('running'));
          assert.ok(!f.calls.includes('consent') && !f.calls.includes('fallback'));
        } finally {
          subscription.dispose();
        }
      });
    },
  },
  {
    name: 'AWS manager: preferred Docker asks once and persists consent only after acceptance',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const request: AwsStartRequest = { ...f.request, backend: 'auto' };
        await f.manager.start(request);
        assert.equal(f.docker.starts.length, 1);
        assert.equal(f.host.starts.length, 0);
        assert.ok(f.calls.includes('consent'));
        assert.ok(f.calls.indexOf('consent') < f.calls.indexOf('store-consent'));
        assert.ok(f.calls.indexOf('consent') < f.calls.indexOf('docker:start'));
        await f.manager.stop();
        await f.manager.start(request);
        assert.equal(f.calls.filter(call => call === 'consent').length, 1);
        assert.equal(f.docker.starts.length, 2);
      });
    },
  },
  {
    name: 'AWS manager: pinned unavailable or unconsented Docker never starts or silently falls back',
    run: async (): Promise<void> => {
      for (const available of [false, true]) {
        await withAws(async f => {
          f.docker.available = available;
          f.allowSocket = false;
          await assert.rejects(f.manager.start({ ...f.request, backend: 'docker' }));
          assert.equal(f.host.starts.length + f.docker.starts.length, 0);
          assert.ok(!f.calls.includes('store-consent') && !f.calls.includes('fallback'));
          assert.equal(f.socketConsent, false);
        });
      }
    },
  },
  {
    name: 'AWS manager: auto fallback after Docker refusal or unavailability requires an affirmative answer',
    run: async (): Promise<void> => {
      for (const available of [false, true]) {
        for (const accepted of [false, true]) {
          await withAws(async f => {
            f.docker.available = available;
            f.allowSocket = false;
            f.allowFallback = accepted;
            const starting = f.manager.start({ ...f.request, backend: 'auto' });
            if (accepted) {
              await starting;
            } else {
              await assert.rejects(starting);
            }
            assert.ok(f.calls.includes('fallback'));
            assert.equal(f.host.starts.length, accepted ? 1 : 0);
            assert.equal(f.docker.starts.length, 0);
            assert.equal(f.socketConsent, false);
          });
        }
      }
    },
  },
  {
    name: 'AWS manager: each externally bound start requires consent and refusal creates no backend',
    run: async (): Promise<void> => {
      await withAws(async f => {
        const request = { ...f.request, bindAddress: '0.0.0.0' };
        f.allowBind = false;
        await assert.rejects(f.manager.start(request));
        assert.equal(f.host.starts.length, 0);
        f.allowBind = true;
        await f.manager.start(request);
        await f.manager.stop();
        await f.manager.start(request);
        assert.equal(f.calls.filter(call => call === 'bind:0.0.0.0').length, 3);
      });
    },
  },
  {
    name: 'AWS manager: pending socket consent permits neither persistence nor Docker start',
    run: async (): Promise<void> => {
      for (const answer of [false, true]) {
        await withAws(async f => {
          const consent = deferred<boolean>();
          f.onSocketConsent = async (): Promise<boolean> => await consent.promise;
          const starting = observe(f.manager.start({ ...f.request, backend: 'docker' }));
          try {
            await waitFor(() => f.calls.includes('consent'), 'consent prompt pending');
            assert.equal(starting.settled, false);
            assert.equal(f.docker.starts.length, 0);
            assert.ok(!f.calls.includes('store-consent'));
            consent.resolve(answer);
            if (answer) { await fulfilled(starting); } else { await rejected(starting); }
            assert.equal(f.calls.includes('store-consent'), answer);
            assert.equal(f.docker.starts.length, answer ? 1 : 0);
          } finally {
            consent.resolve(answer);
            await drain([starting]);
          }
        });
      }
    },
  },
];
