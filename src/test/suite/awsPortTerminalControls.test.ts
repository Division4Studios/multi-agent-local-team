import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import type { AwsBackendStart, AwsEndpoint } from '../../cloud/backend';
import type { TestCase } from './harness';
import { assertDedicatedOptions, assertPortRoles } from './awsPortTerminalOracles';

type PortBinding = Record<'HostIp' | 'HostPort', string>;
type StateMount = Record<'Type' | 'Source' | 'Target', string>;
type PortSpec = Record<'Env', string[]> &
  Partial<Record<'ExposedPorts', Record<string, Record<string, unknown>>>> &
  Record<'HostConfig', Record<'PortBindings', Record<string, PortBinding[]>> &
    Partial<Record<'Mounts', StateMount[]>> & Partial<Record<'Binds', string[]>>>;

interface PortSample {
  readonly options: AwsBackendStart;
  readonly endpoint: AwsEndpoint;
  readonly spec: PortSpec;
}

const portSample = (): PortSample => ({
  options: {
    workspaceRoot: '/fixture', stateDirectory: '/fixture/.malt/aws', bindAddress: '0.0.0.0',
    port: 18473, adminPort: 29861, token: 'port-terminal-synthetic-token=0123456789abcdef',
  },
  endpoint: { gatewayUrl: 'http://127.0.0.1:18473', adminUrl: 'http://127.0.0.1:29861' },
  spec: {
    Env: [
      'MALT_AWS_ENDPOINT=http://127.0.0.1:18473', 'MALT_AWS_ADMIN_PORT=29861',
      'MALT_AWS_HOST=0.0.0.0', 'MALT_AWS_STATE_DIRECTORY=/state',
      'MALT_AWS_ADMIN_TOKEN=port-terminal-synthetic-token=0123456789abcdef',
      'MALT_AWS_PORT=18473', 'MALT_AWS_ADMIN_HOST=0.0.0.0',
    ],
    ExposedPorts: { '18473/tcp': {}, '29861/tcp': {} },
    HostConfig: {
      PortBindings: {
        '18473/tcp': [{ HostIp: '0.0.0.0', HostPort: '18473' }],
        '29861/tcp': [{ HostIp: '127.0.0.1', HostPort: '29861' }],
      },
      Mounts: [{ Type: 'bind', Source: '/fixture/.malt/aws', Target: '/state' }],
    },
  },
});

const accepts = (sample: PortSample): void => { assertPortRoles(sample.spec, sample.options, sample.endpoint); };
const rejects = (sample: PortSample): void => { assert.throws(() => { accepts(sample); }, assert.AssertionError); };

const terminalSample = (): vscode.TerminalOptions => ({
  name: 'MALT Local AWS',
  env: {
    AWS_SESSION_TOKEN: null, AWS_SECURITY_TOKEN: null, AWS_PROFILE: null, AWS_DEFAULT_PROFILE: null,
    AWS_ENDPOINT_URL: 'http://127.0.0.1:18473', AWS_ENDPOINT_URL_STS: 'http://127.0.0.1:18473',
    AWS_ENDPOINT_URL_SQS: 'http://127.0.0.1:18473', AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:18473',
    AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_REGION: 'eu-north-1',
    AWS_DEFAULT_REGION: 'eu-north-1', AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '',
  },
});

const stateEnvironment = (sample: PortSample, target: string): void => {
  sample.spec.Env = sample.spec.Env.map(entry => entry.startsWith('MALT_AWS_STATE_DIRECTORY=')
    ? `MALT_AWS_STATE_DIRECTORY=${target}` : entry);
};

const stateControls: readonly { readonly name: string; readonly prepare: (sample: PortSample) => void }[] = [
  {
    name: 'Binds-only',
    prepare: (sample): void => {
      delete sample.spec.HostConfig.Mounts;
      sample.spec.HostConfig.Binds = [`${sample.options.stateDirectory}:/bind-state:rw`];
      stateEnvironment(sample, '/bind-state');
    },
  },
  {
    name: 'empty Mounts with valid Binds',
    prepare: (sample): void => {
      sample.spec.HostConfig.Mounts = [];
      sample.spec.HostConfig.Binds = [`${sample.options.stateDirectory}:/empty-mount-state`];
      stateEnvironment(sample, '/empty-mount-state');
    },
  },
  {
    name: 'socket in Mounts and state in Binds',
    prepare: (sample): void => {
      sample.spec.HostConfig.Mounts = [{ Type: 'bind', Source: '/fixture/engine.sock', Target: '/var/run/docker.sock' }];
      sample.spec.HostConfig.Binds = [`${sample.options.stateDirectory}:/mixed-bind-state:rw`];
      stateEnvironment(sample, '/mixed-bind-state');
    },
  },
  {
    name: 'state in Mounts and socket in Binds',
    prepare: (sample): void => {
      sample.spec.HostConfig.Mounts = [{ Type: 'bind', Source: sample.options.stateDirectory, Target: '/mixed-mount-state' }];
      sample.spec.HostConfig.Binds = ['/fixture/engine.sock:/var/run/docker.sock:rw'];
      stateEnvironment(sample, '/mixed-mount-state');
    },
  },
];

export const tests: readonly TestCase[] = [
  {
    name: 'AWS port oracle: unordered environment passes, publication-key and runtime-port role swaps fail',
    run: (): void => {
      const valid = portSample();
      accepts(valid);
      valid.spec.Env.reverse();
      accepts(valid);
      const bindingSwap = portSample();
      bindingSwap.spec.HostConfig.PortBindings = {
        '18473/tcp': [{ HostIp: '127.0.0.1', HostPort: '29861' }],
        '29861/tcp': [{ HostIp: '0.0.0.0', HostPort: '18473' }],
      };
      rejects(bindingSwap);
      const listenerSwap = portSample();
      listenerSwap.spec.Env = listenerSwap.spec.Env.map(entry => entry === 'MALT_AWS_PORT=18473'
        ? 'MALT_AWS_PORT=29861' : entry === 'MALT_AWS_ADMIN_PORT=29861' ? 'MALT_AWS_ADMIN_PORT=18473' : entry);
      rejects(listenerSwap);
      const oldKeys = portSample();
      oldKeys.spec.HostConfig.PortBindings = {
        '4566/tcp': [{ HostIp: '0.0.0.0', HostPort: '18473' }],
        '4567/tcp': [{ HostIp: '127.0.0.1', HostPort: '29861' }],
      };
      oldKeys.spec.ExposedPorts = { '4566/tcp': {}, '4567/tcp': {} };
      rejects(oldKeys);
    },
  },
  {
    name: 'AWS port oracle: missing, partial, extra and nonempty ExposedPorts fail',
    run: (): void => {
      accepts(portSample());
      const missing = portSample();
      delete missing.spec.ExposedPorts;
      rejects(missing);
      for (const exposed of [
        { '18473/tcp': {} }, { '18473/tcp': {}, '29861/tcp': {}, '4566/tcp': {} },
        { '18473/tcp': { unexpected: true }, '29861/tcp': {} },
      ]) {
        const sample = portSample();
        sample.spec.ExposedPorts = exposed;
        rejects(sample);
      }
    },
  },
  {
    name: 'AWS port oracle: fixed environment values are explicit, unambiguous and reach both container listeners',
    run: (): void => {
      const valid = portSample();
      accepts(valid);
      for (const entry of valid.spec.Env) {
        const missing = portSample();
        missing.spec.Env = missing.spec.Env.filter(value => value !== entry);
        rejects(missing);
      }
      for (const name of ['MALT_AWS_HOST', 'MALT_AWS_ADMIN_HOST']) {
        const loopback = portSample();
        loopback.spec.Env = loopback.spec.Env.map(entry => entry.startsWith(`${name}=`) ? `${name}=127.0.0.1` : entry);
        rejects(loopback);
      }
      const duplicate = portSample();
      duplicate.spec.Env.push('MALT_AWS_PORT=18473');
      rejects(duplicate);
    },
  },
  {
    name: 'AWS terminal oracle: missing or inherited selectors, extra removals and strict environment fail',
    run: (): void => {
      const check = (options: vscode.TerminalOptions): void => { assertDedicatedOptions(options, 'http://127.0.0.1:18473', 'eu-north-1'); };
      check(terminalSample());
      check({ ...terminalSample(), strictEnv: false });
      for (const key of ['AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE']) {
        const missing = terminalSample();
        assert.ok(missing.env !== undefined);
        missing.env = Object.fromEntries(Object.entries(missing.env).filter(([name]) => name !== key));
        assert.throws(() => { check(missing); }, assert.AssertionError);
        const inherited = terminalSample();
        assert.ok(inherited.env !== undefined);
        inherited.env[key] = 'inherited-synthetic-credential-selector';
        assert.throws(() => { check(inherited); }, assert.AssertionError);
      }
      assert.throws(() => { check({ ...terminalSample(), strictEnv: true }); }, assert.AssertionError);
      const extra = terminalSample();
      assert.ok(extra.env !== undefined);
      extra.env['UNRELATED_USER_SETTING'] = null;
      assert.throws(() => { check(extra); }, assert.AssertionError);
    },
  },
  ...stateControls.map(({ name, prepare }): TestCase => ({
    name: `AWS state mapping oracle: ${name} is valid`,
    run: (): void => {
      const sample = portSample();
      prepare(sample);
      accepts(sample);
    },
  })),
  {
    name: 'AWS state mapping oracle: absent state binding and mismatched environment target fail',
    run: (): void => {
      const missing = portSample();
      accepts(missing);
      missing.spec.HostConfig.Mounts = [];
      missing.spec.HostConfig.Binds = ['/fixture/engine.sock:/var/run/docker.sock:rw'];
      rejects(missing);
      const mismatched = portSample();
      delete mismatched.spec.HostConfig.Mounts;
      mismatched.spec.HostConfig.Binds = [`${mismatched.options.stateDirectory}:/bound-state:rw`];
      stateEnvironment(mismatched, '/bound-state');
      accepts(mismatched);
      stateEnvironment(mismatched, '/unbound-state');
      rejects(mismatched);
    },
  },
];
