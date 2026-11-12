/** These controls establish oracle/fixture sensitivity, never cloud implementation success. */
import assert from 'node:assert/strict';
import type { AwsEndpoint } from '../../cloud/backend';
import type { TestCase } from './harness';
import { deferred, waitFor } from './testUtils';
import { FakeBackend, assertRemoved } from './awsBackendFixture';
import { drain, fulfilled, observe } from './awsAsyncFixture';
import { TEST_ENDPOINT, TEST_TOKEN, healthValue } from './awsData';
import { dockerFixture } from './awsDockerFixture';
import { engineRequest, replyValue } from './awsEngineProbeFixture';
import { assertForeignPreserved, assertOwnedAbsent, labelsOf, oneLabelMismatch } from './awsOwnershipFixture';
import { EXCERPT_MARKERS, RESPONSE_LIMIT, assertSafeError, assertSafeRejection, paddedHealth, responseScenarios } from './awsAdminOracleFixture';

const options = {
  workspaceRoot: 'control-workspace', stateDirectory: 'control-state', bindAddress: '127.0.0.1', port: 4566, adminPort: 14566, token: TEST_TOKEN,
};

export const tests: readonly TestCase[] = [
  {
    name: 'AWS harness control P1: stopping before startup resolves cannot satisfy the late-resource-removal oracle',
    run: async (): Promise<void> => {
      const backend = new FakeBackend('host', []);
      const gate = deferred<AwsEndpoint>();
      backend.onStart = async (): Promise<AwsEndpoint> => await gate.promise;
      const starting = observe(backend.start(options));
      try {
        await backend.stop(); // Deliberately defective manager schedule.
        gate.resolve(TEST_ENDPOINT);
        await fulfilled(starting);
        assert.ok(backend.stops > 0, 'the original invocation-only oracle would pass');
        assert.throws(() => { assertRemoved(backend, 1); });
        await backend.stop();
        assertRemoved(backend, 1);
      } finally {
        gate.resolve(TEST_ENDPOINT);
        await drain([starting]);
        await backend.stop();
      }
    },
  },
  {
    name: 'AWS harness control P1: pending removal cannot satisfy cleanup-complete or replacement-order assertions',
    run: async (): Promise<void> => {
      const backend = new FakeBackend('host', []);
      await backend.start(options);
      const gate = deferred<undefined>();
      backend.onStop = async (): Promise<void> => { await gate.promise; };
      const stopping = observe(backend.stop());
      try {
        await waitFor(() => backend.stops === 1, 'cleanup entered');
        assert.equal(stopping.settled, false);
        assert.throws(() => { assertRemoved(backend, 1); });
        await backend.start(options); // Deliberately overtake the pending cleanup.
        assert.throws(() => { assert.equal(backend.starts.length, 1); });
        gate.resolve(undefined);
        await fulfilled(stopping);
        assertRemoved(backend, 1);
        assert.ok(backend.live.has(2), 'cleanup captures only resources present when it began');
      } finally {
        gate.resolve(undefined);
        await drain([stopping]);
        backend.onStop = undefined;
        await backend.stop();
      }
    },
  },
  {
    name: 'AWS harness control P1: current-owner-only validation is caught by each isolated role/workspace mismatch',
    run: async (): Promise<void> => {
      const current: Readonly<Record<string, string>> = { 'dev.malt.role': 'aws-gateway', 'dev.malt.workspace': 'current-workspace', 'control.owner': 'CURRENT-START' };
      for (const key of Object.keys(current)) {
        const engine = await dockerFixture();
        engine.conflict = true;
        engine.conflictLabels = (spec): Record<string, string> => oneLabelMismatch(labelsOf(spec['Labels']), key);
        try {
          assert.equal((await engineRequest(engine, 'POST', '/containers/create?name=collision', { Labels: current })).status, 409);
          const foreign = engine.foreignContainers[0];
          assert.ok(foreign !== undefined);
          const labels = labelsOf(foreign.spec['Labels']);
          assert.deepEqual(Object.keys(labels).filter(name => labels[name] !== current[name]), [key]);
          assertForeignPreserved(engine);
          if (labels['control.owner'] === current['control.owner']) {
            assert.equal((await engineRequest(engine, 'DELETE', `/containers/${foreign.id}?force=1`)).status, 204);
            assert.throws(() => { assertForeignPreserved(engine); }, 'an owner-only reclaim must fail the actual test oracle');
          } else {
            assert.equal(key, 'control.owner');
          }
        } finally {
          await engine.close();
        }
      }
    },
  },
  {
    name: 'AWS harness control P1: Engine enforces existence, HTTP methods, names, running state and exact removal target',
    run: async (): Promise<void> => {
      const engine = await dockerFixture();
      try {
        for (const [method, path] of [['POST', '/containers/missing/start'], ['DELETE', '/containers/missing'], ['GET', '/containers/missing/json']]) {
          assert.ok(method !== undefined && path !== undefined);
          assert.equal((await engineRequest(engine, method, path)).status, 404);
        }
        assert.equal((await engineRequest(engine, 'GET', '/containers/create?name=owned')).status, 405);
        assert.equal((await engineRequest(engine, 'POST', '/containers/create?name=owned', { Labels: {} })).status, 201);
        const container = engine.containers[0];
        assert.ok(container !== undefined);
        assert.deepEqual(replyValue(await engineRequest(engine, 'GET', '/containers/owned/json')), {
          Id: container.id, Name: '/owned', Config: { Labels: {} }, State: { Running: false },
        });
        assert.equal((await engineRequest(engine, 'POST', '/containers/create?name=owned', {})).status, 409);
        assert.equal((await engineRequest(engine, 'GET', '/containers/owned/start')).status, 405);
        assert.equal((await engineRequest(engine, 'DELETE', '/containers/owned/start')).status, 405);
        assert.equal(container.running, false);
        assert.equal((await engineRequest(engine, 'POST', '/containers/owned/start')).status, 204);
        assert.equal(container.running, true);
        assert.deepEqual(replyValue(await engineRequest(engine, 'GET', '/containers/owned/json')), {
          Id: container.id, Name: '/owned', Config: { Labels: {} }, State: { Running: true },
        });
        assert.equal((await engineRequest(engine, 'POST', '/containers/owned/json')).status, 405);
        assert.equal((await engineRequest(engine, 'DELETE', '/containers/wrong-id')).status, 404);
        assert.throws(() => { assertOwnedAbsent(engine, container.id); });
        assert.equal((await engineRequest(engine, 'DELETE', '/containers/owned')).status, 409);
        assert.equal((await engineRequest(engine, 'POST', '/containers/owned/stop')).status, 204);
        assert.equal(container.running, false);
        assert.deepEqual(replyValue(await engineRequest(engine, 'GET', '/containers/json')), []);
        assert.deepEqual(replyValue(await engineRequest(engine, 'GET', '/containers/json?all=1')), [
          { Id: container.id, Names: ['/owned'], Labels: {}, State: 'exited' },
        ]);
        assert.equal((await engineRequest(engine, 'DELETE', '/containers/owned')).status, 204);
        assertOwnedAbsent(engine, container.id);
        assert.equal((await engineRequest(engine, 'GET', `/containers/${container.id}/json`)).status, 404);
        assert.equal((await engineRequest(engine, 'POST', '/containers/create?name=owned', {})).status, 201);
      } finally {
        await engine.close();
      }
    },
  },
  {
    name: 'AWS harness control P1: conflict inspection resolves one foreign name and failure modes preserve real state',
    run: async (): Promise<void> => {
      const engine = await dockerFixture();
      engine.conflict = true;
      try {
        assert.equal((await engineRequest(engine, 'POST', '/containers/create?name=taken', { Labels: {} })).status, 409);
        assert.equal((await engineRequest(engine, 'GET', '/containers/taken/json')).status, 200);
        assert.equal((await engineRequest(engine, 'GET', '/containers/unrelated/json')).status, 404);
        assertForeignPreserved(engine);
        await engineRequest(engine, 'POST', '/containers/create?name=owned', {});
        const owned = engine.containers[0];
        assert.ok(owned !== undefined);
        engine.failStart = true;
        assert.equal((await engineRequest(engine, 'POST', `/containers/${owned.id}/start`)).status, 500);
        assert.equal(owned.running, false);
        engine.failRemove = true;
        assert.equal((await engineRequest(engine, 'DELETE', `/containers/${owned.id}`)).status, 500);
        assert.throws(() => { assertOwnedAbsent(engine, owned.id); });
        engine.failRemove = false;
        assert.equal((await engineRequest(engine, 'DELETE', `/containers/${owned.id}`)).status, 204);
        assertOwnedAbsent(engine, owned.id);
      } finally {
        await engine.close();
      }
    },
  },
  {
    name: 'AWS harness control P2: media/size fixtures are valid DTO JSON and accepting them fails the rejection oracle',
    run: async (): Promise<void> => {
      for (const scenario of responseScenarios().filter(value => value.reason === 'media type only' || value.reason === 'advertised size only')) {
        const value: unknown = JSON.parse(scenario.body);
        assert.deepEqual(value, healthValue());
        assert.equal(scenario.status, 200);
        assert.equal(scenario.extra, 0);
        if (scenario.reason === 'media type only') { assert.ok(Buffer.byteLength(scenario.body) < RESPONSE_LIMIT); }
        else { assert.equal(scenario.type, 'application/json'); assert.equal(Buffer.byteLength(scenario.body), RESPONSE_LIMIT + 1); }
        await assert.rejects(assertSafeRejection(Promise.resolve(value)), assert.AssertionError);
      }
      const boundary: unknown = JSON.parse(paddedHealth(RESPONSE_LIMIT));
      assert.deepEqual(boundary, healthValue());
      assert.equal(Buffer.byteLength(paddedHealth(RESPONSE_LIMIT)), RESPONSE_LIMIT);
    },
  },
  {
    name: 'AWS harness control P2: parser excerpts and partial markers fail the safe-error oracle; static errors pass',
    run: (): void => {
      let parserError: unknown;
      try { JSON.parse('ZXQ-QZ7-private-response'); } catch (error: unknown) { parserError = error; }
      assert.ok(parserError instanceof Error && EXCERPT_MARKERS.some(marker => parserError.message.includes(marker)));
      assert.throws(() => { assertSafeError(parserError); }, assert.AssertionError);
      for (const marker of EXCERPT_MARKERS) { assert.throws(() => { assertSafeError(new Error(`Invalid JSON: ${marker}`)); }); }
      assert.throws(() => { assertSafeError(new Error(TEST_TOKEN)); });
      assert.throws(() => { assertSafeError(new Error('Admin response rejected', { cause: new Error('ZXQ excerpt') })); });
      assert.throws(() => { assertSafeError(new Error('test fixture deadline exceeded')); });
      assertSafeError(new Error('Admin response rejected'));
    },
  },
];
