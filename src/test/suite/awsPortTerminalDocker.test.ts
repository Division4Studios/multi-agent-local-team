import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { AwsBackend, AwsBackendStart } from '../../cloud/backend';
import { AwsDockerBackend } from '../../cloud/dockerBackend';
import type { TestCase } from './harness';
import { dockerFixture } from './awsDockerFixture';
import { freePort } from './awsHttpFixture';
import { TEST_TOKEN } from './awsData';
import { assertOwnedAbsent } from './awsOwnershipFixture';
import { assertPortRoles } from './awsPortTerminalOracles';

export const tests: readonly TestCase[] = ['127.0.0.1', '0.0.0.0'].map(bindAddress => ({
  name: `AWS Docker port roles: asymmetric listeners, explicit exposure and host publication on ${bindAddress}`,
  run: async (): Promise<void> => {
    const engine = await dockerFixture();
    const logs: string[] = [];
    let docker: AwsBackend | undefined;
    try {
      const extension = vscode.extensions.getExtension<unknown>('division4studios.malt');
      assert.ok(extension !== undefined);
      docker = new AwsDockerBackend({ extensionRoot: extension.extensionPath, socketPath: engine.socketPath, log: (message: string): void => { logs.push(message); } });
      const stateDirectory = join(engine.root, '.malt', 'aws');
      await mkdir(stateDirectory, { recursive: true });
      const options: AwsBackendStart = {
        workspaceRoot: engine.root, stateDirectory, bindAddress,
        port: await freePort(), adminPort: Number(new URL(engine.admin.origin).port), token: TEST_TOKEN,
      };
      assert.notEqual(options.port, options.adminPort);
      assert.notEqual(options.port, 4566);
      assert.notEqual(options.adminPort, 4566);
      const endpoint = await engine.track(docker.start(options));
      assert.equal(engine.containers.length, 1);
      const created = engine.containers[0];
      assert.ok(created !== undefined);
      assert.equal(engine.find(created.id)?.running, true);
      assertPortRoles(created.spec, options, endpoint);
      assert.equal(endpoint.adminUrl, engine.admin.origin);
      assert.ok(!logs.join('\n').includes(TEST_TOKEN));
    } finally {
      try {
        if (docker !== undefined) { await engine.track(docker.stop()); }
        for (const created of engine.containers) { assertOwnedAbsent(engine, created.id); }
      } finally {
        await engine.close();
      }
    }
  },
}));
