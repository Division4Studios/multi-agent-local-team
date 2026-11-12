import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { isRecord } from '../../shared/guards';
import type { TestCase } from './harness';
import { AWS_COMMANDS } from './awsCommandFixture';

const extension = (): vscode.Extension<unknown> => {
  const value = vscode.extensions.getExtension<unknown>('division4studios.malt');
  assert.ok(value !== undefined, 'MALT must be installed in the real extension test host');
  return value;
};

const contribution = async (): Promise<Record<string, unknown>> => {
  const manifest: unknown = JSON.parse(await readFile(join(extension().extensionPath, 'package.json'), 'utf8'));
  assert.ok(isRecord(manifest));
  const contributes = manifest['contributes'];
  assert.ok(isRecord(contributes));
  return contributes;
};

const records = (value: unknown): Record<string, unknown>[] => {
  assert.ok(Array.isArray(value));
  const result: Record<string, unknown>[] = [];
  for (const item of value) {
    assert.ok(isRecord(item));
    result.push(item);
  }
  return result;
};

const properties = (configuration: unknown): Record<string, unknown> => {
  const entries = Array.isArray(configuration) ? records(configuration) : [configuration];
  const result: Record<string, unknown> = {};
  for (const entry of entries) {
    assert.ok(isRecord(entry));
    assert.ok(isRecord(entry['properties']));
    Object.assign(result, entry['properties']);
  }
  return result;
};

export const tests: readonly TestCase[] = [
  {
    name: 'AWS native manifest: exactly the reviewed commands and native Local AWS Emulator tree contribution',
    run: async (): Promise<void> => {
      const contributes = await contribution();
      const commands = records(contributes['commands']).map(command => command['command']);
      const awsCommands = commands.filter(command => typeof command === 'string' && command.startsWith('malt.aws.'));
      assert.deepEqual(new Set(awsCommands), new Set(AWS_COMMANDS));
      assert.equal(awsCommands.length, AWS_COMMANDS.length, 'no duplicate contributions');
      const views = contributes['views'];
      assert.ok(isRecord(views));
      const aws = records(views['malt']).filter(view => view['id'] === 'malt.aws');
      assert.equal(aws.length, 1);
      const view = aws[0];
      assert.ok(view !== undefined);
      assert.equal(view['name'], 'Local AWS Emulator');
      assert.notEqual(view['type'], 'webview');
    },
  },
  {
    name: 'AWS native manifest: implemented settings only, exact defaults, port bounds and machine-scoped backend/binding',
    run: async (): Promise<void> => {
      const all = properties((await contribution())['configuration']);
      const expected: Readonly<Record<string, unknown>> = {
        'malt.aws.backend': 'auto', 'malt.aws.port': 4566, 'malt.aws.bindAddress': '127.0.0.1',
        'malt.aws.stateDirectory': '.malt/aws', 'malt.aws.region': 'us-east-1', 'malt.aws.terminal.inject': false,
      };
      assert.deepEqual(new Set(Object.keys(all).filter(key => key.startsWith('malt.aws.'))), new Set(Object.keys(expected)));
      for (const [key, value] of Object.entries(expected)) {
        const setting = all[key];
        assert.ok(isRecord(setting), key);
        assert.equal(setting['default'], value, key);
      }
      const backend = all['malt.aws.backend'];
      const binding = all['malt.aws.bindAddress'];
      const port = all['malt.aws.port'];
      assert.ok(isRecord(backend) && isRecord(binding) && isRecord(port));
      assert.deepEqual(new Set(recordsForEnum(backend['enum'])), new Set(['auto', 'host', 'docker']));
      assert.equal(backend['scope'], 'machine');
      assert.equal(binding['scope'], 'machine');
      assert.equal(port['type'], 'integer');
      assert.equal(port['minimum'], 1);
      assert.equal(port['maximum'], 65535);
      const socket = all['malt.docker.socketPath'];
      assert.ok(isRecord(socket));
      assert.equal(socket['scope'], 'machine');
    },
  },
  {
    name: 'AWS native activation: all public commands and the tree focus command are actually registered',
    run: async (): Promise<void> => {
      await extension().activate();
      const commands = new Set(await vscode.commands.getCommands(true));
      for (const id of [...AWS_COMMANDS, 'malt.aws.focus']) {
        assert.ok(commands.has(id), `missing native command ${id}`);
      }
      assert.ok(commands.has('malt.startReviewer') && commands.has('malt.stopReviewer'), 'reviewer commands survive cloud wiring');
    },
  },
];

const recordsForEnum = (value: unknown): string[] => {
  assert.ok(Array.isArray(value));
  return value.map((item: unknown): string => { assert.equal(typeof item, 'string'); return String(item); });
};
