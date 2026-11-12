import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { AwsBackend, AwsBackendStart } from '../../cloud/backend';
import { AwsDockerBackend } from '../../cloud/dockerBackend';
import { isRecord } from '../../shared/guards';
import type { TestCase } from './harness';
import { dockerFixture, tarEntries } from './awsDockerFixture';
import type { CreatedContainer, DockerFixture } from './awsDockerFixture';
import { bounded, freePort } from './awsHttpFixture';
import { TEST_TOKEN } from './awsData';
import { assertForeignPreserved, assertOwnedAbsent, labelsOf, oneLabelMismatch } from './awsOwnershipFixture';

const record = (value: unknown): Record<string, unknown> => { assert.ok(isRecord(value)); return value; };
const records = (value: unknown): Record<string, unknown>[] => { assert.ok(Array.isArray(value)); return value.map(record); };

const finish = async (docker: AwsBackend, engine: DockerFixture): Promise<void> => {
  try {
    await bounded(docker.stop());
  } finally {
    await engine.close();
  }
};

const rejectsBackend = async (operation: Promise<unknown>): Promise<void> => {
  await assert.rejects(bounded(operation), (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.notEqual(error.message, 'test fixture deadline exceeded', 'the backend must reject, not merely outlive the test deadline');
    return true;
  });
};

const bindMounts = (host: Record<string, unknown>): Record<string, unknown>[] => {
  if (host['Mounts'] !== undefined) {
    return records(host['Mounts']);
  }
  const binds = host['Binds'];
  assert.ok(Array.isArray(binds));
  return binds.map((value: unknown): Record<string, unknown> => {
    assert.equal(typeof value, 'string');
    const match = /^(.*):(\/[^:]+)(?::([^:]+))?$/u.exec(String(value));
    assert.ok(match !== null);
    return { Type: 'bind', Source: match[1], Target: match[2], ReadOnly: (match[3] ?? 'rw').split(',').includes('ro') };
  });
};

const backend = (engine: DockerFixture, logs: string[] = []): AwsBackend => {
  const extension = vscode.extensions.getExtension<unknown>('division4studios.malt');
  assert.ok(extension !== undefined);
  const concrete = new AwsDockerBackend({ extensionRoot: extension.extensionPath, socketPath: engine.socketPath, log: (line: string): void => { logs.push(line); } });
  return {
    kind: 'docker',
    isAvailable: async (): Promise<boolean> => await engine.track(concrete.isAvailable()),
    start: async options => await engine.track(concrete.start(options)),
    stop: async (): Promise<void> => { await engine.track(concrete.stop()); },
  };
};

const optionsFor = async (engine: DockerFixture): Promise<AwsBackendStart> => {
  const stateDirectory = join(engine.root, '.malt', 'aws');
  await mkdir(stateDirectory, { recursive: true });
  return {
    workspaceRoot: engine.root, stateDirectory, bindAddress: '0.0.0.0', port: await freePort(),
    adminPort: Number(new URL(engine.admin.origin).port), token: TEST_TOKEN,
  };
};

const assertSecurity = (created: CreatedContainer, options: AwsBackendStart): void => {
  const { spec } = created;
  assert.equal(typeof spec['User'], 'string');
  assert.ok(String(spec['User']).length > 0);
  assert.doesNotMatch(String(spec['User']), /^(?:root|0)(?::|$)/u);
  const host = record(spec['HostConfig']);
  assert.equal(host['ReadonlyRootfs'], true);
  assert.ok(Array.isArray(host['CapDrop']) && host['CapDrop'].includes('ALL'));
  assert.notEqual(host['Privileged'], true);
  assert.ok(Array.isArray(host['SecurityOpt']) && host['SecurityOpt'].some(option => option === 'no-new-privileges' || option === 'no-new-privileges:true'));
  assert.ok(typeof host['Memory'] === 'number' && host['Memory'] > 0);
  assert.ok(typeof host['PidsLimit'] === 'number' && host['PidsLimit'] > 0);
  assert.ok(Object.values(record(host['Tmpfs'])).some(value => typeof value === 'string' && /(?:^|,)rw(?:,|$)/u.test(value)));
  const mounts = bindMounts(host);
  const state = mounts.find(mount => mount['Source'] === options.stateDirectory);
  assert.ok(state !== undefined);
  assert.equal(state['Type'], 'bind');
  assert.notEqual(state['ReadOnly'], true);
  assert.ok(!mounts.some(mount => mount['Source'] === options.workspaceRoot));
  const socket = mounts.find(mount => mount['Target'] === '/var/run/docker.sock');
  assert.ok(socket !== undefined);
  assert.equal(socket['Source'], '/var/run/docker.sock', 'Docker Desktop mounts its Linux socket, not the host named pipe');
  assert.notEqual(socket['ReadOnly'], true);
};

const assertPublication = (created: CreatedContainer, options: AwsBackendStart): void => {
  const host = record(created.spec['HostConfig']);
  const ports = record(host['PortBindings']);
  const keys = Object.keys(ports);
  assert.equal(keys.length, 2);
  const exposed = created.spec['ExposedPorts'];
  if (exposed !== undefined) { assert.deepEqual(new Set(keys), new Set(Object.keys(record(exposed)))); }
  for (const key of keys) {
    assert.match(key, /^[1-9][0-9]{0,4}\/tcp$/u);
    assert.ok(Number(key.split('/')[0]) <= 65535);
    assert.equal(records(ports[key]).length, 1);
  }
  const gateway = keys.find(key => records(ports[key])[0]?.['HostPort'] === String(options.port));
  const admin = keys.find(key => records(ports[key])[0]?.['HostPort'] === String(options.adminPort));
  assert.ok(gateway !== undefined && admin !== undefined && gateway !== admin);
  assert.deepEqual(ports, {
    [gateway]: [{ HostIp: options.bindAddress, HostPort: String(options.port) }],
    [admin]: [{ HostIp: '127.0.0.1', HostPort: String(options.adminPort) }],
  });
};

const assertContext = (context: Buffer): void => {
  const entries = tarEntries(context);
  const dockerfile = entries.get('Dockerfile');
  assert.ok(dockerfile !== undefined);
  const text = dockerfile.toString('utf8');
  assert.match(text, /node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c/u);
  assert.match(text, /\b(?:CMD|ENTRYPOINT)\b[\s\S]*\bnode\b/u);
  assert.match(text, /\b(?:CMD|ENTRYPOINT)\b[\s\S]*aws\/main\.js/u);
  assert.doesNotMatch(text, /npm\s+(?:ci|install)|npx\s/u);
  const paths = [...entries.keys()];
  assert.ok(paths.some(path => /^(?:out\/)?aws\/main\.js$/u.test(path)));
  assert.ok(paths.some(path => /^(?:out\/)?shared\/.+\.js$/u.test(path)));
  assert.ok(paths.some(path => /(?:^|\/)test-evidence\.json$/u.test(path)));
  assert.ok(paths.some(path => /licen[cs]e|notice/iu.test(path)));
  for (const path of paths) {
    assert.doesNotMatch(path, /(?:^|\/)(?:src|reviewer|test|node_modules|\.git)(?:\/|$)|\.test\.js$|\.map$/u);
    assert.ok(path === 'Dockerfile' || /^(?:out\/)?(?:aws|shared)\//u.test(path) || /licen[cs]e|notice/iu.test(path), `unexpected context asset: ${path}`);
  }
};

export const tests: readonly TestCase[] = [
  {
    name: 'AWS Docker boundary: concrete Engine create request has socket/state isolation, hardening and separate publication',
    run: async (): Promise<void> => {
      const engine = await dockerFixture();
      const logs: string[] = [];
      const docker = backend(engine, logs);
      try {
        assert.equal(await docker.isAvailable(), true);
        const options = await optionsFor(engine);
        const endpoint = await bounded(docker.start(options));
        const created = engine.containers[0];
        assert.ok(created !== undefined);
        assert.equal(engine.find(created.id)?.running, true);
        assertSecurity(created, options);
        assertPublication(created, options);
        const labels = record(created.spec['Labels']);
        assert.equal(labels['dev.malt.role'], 'aws-gateway');
        assert.ok(typeof labels['dev.malt.workspace'] === 'string' && labels['dev.malt.workspace'].length > 0);
        assert.ok(Object.keys(labels).some(key => key !== 'dev.malt.role' && key !== 'dev.malt.workspace'));
        assert.equal(endpoint.adminUrl, engine.admin.origin);
        assert.equal(new URL(endpoint.gatewayUrl).port, String(options.port));
        assert.ok(JSON.stringify(created.spec).includes(endpoint.gatewayUrl), 'the advertised host endpoint must reach the runtime');
        assert.ok(!logs.join('\n').includes(TEST_TOKEN));
        const context = engine.builds[0];
        assert.ok(context !== undefined);
        assertContext(context);
      } finally {
        await finish(docker, engine);
      }
    },
  },
  {
    name: 'AWS Docker boundary: context/image are deterministic while ownership changes for every start and state survives',
    run: async (): Promise<void> => {
      const engine = await dockerFixture();
      const docker = backend(engine);
      try {
        const options = await optionsFor(engine);
        const sentinel = join(options.stateDirectory, 'owned-test-sentinel');
        await writeFile(sentinel, 'persistent-state');
        await bounded(docker.start(options));
        const initial = engine.containers[0];
        assert.ok(initial !== undefined);
        await docker.stop();
        assertOwnedAbsent(engine, initial.id);
        await bounded(docker.start({ ...options, token: `${TEST_TOKEN}-fresh` }));
        const first = engine.containers[0];
        const second = engine.containers[1];
        assert.ok(first !== undefined && second !== undefined);
        assert.equal(first.spec['Image'], second.spec['Image']);
        for (const context of engine.builds) { assert.deepEqual(context, engine.builds[0]); }
        const a = record(first.spec['Labels']);
        const b = record(second.spec['Labels']);
        assert.equal(a['dev.malt.workspace'], b['dev.malt.workspace']);
        assert.ok(Object.keys(a).some(key => key !== 'dev.malt.role' && key !== 'dev.malt.workspace' && a[key] !== b[key]));
        await docker.stop();
        assertOwnedAbsent(engine, first.id);
        assertOwnedAbsent(engine, second.id);
        assert.equal(await readFile(sentinel, 'utf8'), 'persistent-state');
        assert.ok(engine.requests.filter(request => request.method === 'DELETE').length >= 2);
      } finally {
        await finish(docker, engine);
      }
    },
  },
  {
    name: 'AWS Docker ownership: a name collision never authorizes removal of a foreign container',
    run: async (): Promise<void> => {
      const engine = await dockerFixture();
      const docker = backend(engine);
      engine.conflict = true;
      try {
        await rejectsBackend(docker.start(await optionsFor(engine)));
        await docker.stop();
        assert.equal(engine.containers.length, 0);
        assertForeignPreserved(engine);
        assert.ok(!engine.requests.some(request => request.method === 'DELETE'));
      } finally {
        await finish(docker, engine);
      }
    },
  },
  {
    name: 'AWS Docker ownership: role, workspace and per-start ownership must all match before reclaiming a name',
    run: async (): Promise<void> => {
      for (const mismatch of ['role', 'workspace', 'previous-start']) {
        const engine = await dockerFixture();
        const docker = backend(engine);
        try {
          const options = await optionsFor(engine);
          await bounded(docker.start(options));
          const created = engine.containers[0];
          assert.ok(created !== undefined);
          await docker.stop();
          assertOwnedAbsent(engine, created.id);
          const previous = labelsOf(created.spec['Labels']);
          engine.conflictLabels = (spec): Record<string, string> => {
            const current = labelsOf(spec['Labels']);
            if (mismatch !== 'previous-start') { return oneLabelMismatch(current, `dev.malt.${mismatch}`); }
            assert.equal(previous['dev.malt.role'], current['dev.malt.role']);
            assert.equal(previous['dev.malt.workspace'], current['dev.malt.workspace']);
            // The owner key is unspecified; retain the entire previous start's label set.
            return { ...previous };
          };
          engine.conflict = true;
          const previousDeletes = engine.requests.filter(request => request.method === 'DELETE').length;
          await rejectsBackend(docker.start({ ...options, token: `${TEST_TOKEN}-next` }));
          await docker.stop();
          assert.equal(engine.requests.filter(request => request.method === 'DELETE').length, previousDeletes, mismatch);
          assertForeignPreserved(engine);
        } finally {
          await finish(docker, engine);
        }
      }
    },
  },
  {
    name: 'AWS Docker ownership: failed start can clean only its created ID; cleanup refusal is surfaced',
    run: async (): Promise<void> => {
      const engine = await dockerFixture();
      const docker = backend(engine);
      engine.failStart = true;
      try {
        await rejectsBackend(docker.start(await optionsFor(engine)));
        const created = engine.containers[0];
        assert.ok(created !== undefined);
        await docker.stop();
        assertOwnedAbsent(engine, created.id);
        const deletes = engine.requests.filter(request => request.method === 'DELETE');
        assert.ok(deletes.length > 0);
        for (const request of deletes) {
          const target = decodeURIComponent(new URL(request.url, 'http://docker.invalid').pathname.split('/').at(-1) ?? '');
          if (target !== created.id) {
            assert.equal(target, created.name);
            const preceding = engine.requests.slice(0, engine.requests.indexOf(request));
            assert.ok(preceding.some(previous => previous.method === 'GET' && decodeURIComponent(previous.url).includes(`/containers/${created.name}/json`)), 'name cleanup requires independent ownership inspection');
          }
        }
        engine.failStart = false;
        await bounded(docker.start(await optionsFor(engine)));
        engine.failRemove = true;
        await rejectsBackend(docker.stop());
        const unremoved = engine.containers.at(-1);
        assert.ok(unremoved !== undefined && engine.find(unremoved.id) !== undefined);
      } finally {
        engine.failRemove = false;
        await finish(docker, engine);
      }
    },
  },
  ...nativeSocketTests(),
];

function nativeSocketTests(): TestCase[] {
  if (process.platform !== 'linux') {
    return [];
  }
  return [{
    name: 'AWS Docker native Linux: non-root socket access derives the real socket group',
    run: async (): Promise<void> => {
      const engine = await dockerFixture();
      engine.operatingSystem = 'Ubuntu 24.04 LTS';
      const docker = backend(engine);
      try {
        await bounded(docker.start(await optionsFor(engine)));
        const created = engine.containers[0];
        assert.ok(created !== undefined);
        const group = String((await stat(engine.socketPath)).gid);
        const host = record(created.spec['HostConfig']);
        const socket = bindMounts(host).find(mount => mount['Target'] === '/var/run/docker.sock');
        assert.ok(socket !== undefined);
        assert.equal(socket['Source'], engine.socketPath);
        assert.equal(socket['Type'], 'bind');
        assert.notEqual(socket['ReadOnly'], true);
        const groups: unknown = host['GroupAdd'];
        assert.ok(String(created.spec['User']).split(':')[1] === group || (Array.isArray(groups) && groups.includes(group)));
        assert.doesNotMatch(String(created.spec['User']), /^(?:root|0)(?::|$)/u);
      } finally {
        await finish(docker, engine);
      }
    },
  }];
}
