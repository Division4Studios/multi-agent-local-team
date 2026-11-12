/** Public port/terminal contracts approved at 9c5173d; no cloud implementation oracle. */
import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import type { AwsBackendStart, AwsEndpoint } from '../../cloud/backend';
import { isRecord } from '../../shared/guards';

const record = (value: unknown): Record<string, unknown> => {
  assert.ok(isRecord(value));
  return value;
};

const stateTarget = (host: Record<string, unknown>, source: string): string => {
  const targets: string[] = [];
  if (Array.isArray(host['Mounts'])) {
    const mounts = host['Mounts'].map(record).filter(mount => mount['Source'] === source);
    for (const mount of mounts) {
      assert.equal(mount['Type'], 'bind');
      assert.equal(typeof mount['Target'], 'string');
      targets.push(String(mount['Target']));
    }
  }
  const binds: unknown = host['Binds'];
  if (Array.isArray(binds)) {
    const matches = binds.filter((bind: unknown): bind is string => typeof bind === 'string' && bind.startsWith(`${source}:/`));
    for (const match of matches) { targets.push(match.slice(source.length + 1).split(':')[0] ?? ''); }
  }
  assert.equal(targets.length, 1, 'one explicit state-directory mapping across Mounts and Binds');
  const target = targets[0];
  assert.ok(target !== undefined);
  return target;
};

export const assertPortRoles = (payload: unknown, options: AwsBackendStart, endpoint: AwsEndpoint): void => {
  assert.notEqual(options.port, options.adminPort, 'fixture ports must be asymmetric');
  const spec = record(payload);
  const host = record(spec['HostConfig']);
  const gatewayKey = `${String(options.port)}/tcp`;
  const adminKey = `${String(options.adminPort)}/tcp`;
  assert.deepEqual(host['PortBindings'], {
    [gatewayKey]: [{ HostIp: options.bindAddress, HostPort: String(options.port) }],
    [adminKey]: [{ HostIp: '127.0.0.1', HostPort: String(options.adminPort) }],
  }, 'chosen internal TCP keys must retain their gateway/admin publication roles');
  assert.deepEqual(spec['ExposedPorts'], { [gatewayKey]: {}, [adminKey]: {} }, 'explicit exposure must match both listeners exactly');
  assert.equal(endpoint.adminUrl, `http://127.0.0.1:${String(options.adminPort)}`);
  const gateway = new URL(endpoint.gatewayUrl);
  assert.equal(gateway.protocol, 'http:');
  assert.equal(gateway.origin, endpoint.gatewayUrl);
  assert.equal(gateway.port, String(options.port));
  assert.equal(gateway.username + gateway.password, '');
  assert.ok(!['0.0.0.0', '[::]', '::'].includes(gateway.hostname), 'advertisement must not use a wildcard listener address');
  const stateDirectory = stateTarget(host, options.stateDirectory);
  assert.match(stateDirectory, /^\/[^\0]+$/u);
  const expected: Readonly<Record<string, string>> = {
    MALT_AWS_HOST: '0.0.0.0', MALT_AWS_PORT: String(options.port),
    MALT_AWS_ADMIN_HOST: '0.0.0.0', MALT_AWS_ADMIN_PORT: String(options.adminPort),
    MALT_AWS_ADMIN_TOKEN: options.token, MALT_AWS_STATE_DIRECTORY: stateDirectory,
    MALT_AWS_ENDPOINT: endpoint.gatewayUrl,
  };
  const env: unknown = spec['Env'];
  assert.ok(Array.isArray(env));
  assert.ok(env.every((entry: unknown) => typeof entry === 'string'));
  for (const [name, value] of Object.entries(expected)) {
    const entries: readonly string[] = env.filter((entry: unknown): entry is string => typeof entry === 'string' && entry.startsWith(`${name}=`));
    assert.deepEqual(entries, [`${name}=${value}`], `${name} must explicitly select its runtime role`);
  }
};

export const assertDedicatedOptions = (options: vscode.TerminalOptions, endpoint: string, region: string): void => {
  assert.equal(options.name, 'MALT Local AWS');
  assert.notEqual(options.strictEnv, true, 'dedicated terminals retain ordinary native inheritance');
  const env = options.env;
  assert.ok(env !== undefined);
  const removals = ['AWS_SESSION_TOKEN', 'AWS_SECURITY_TOKEN', 'AWS_PROFILE', 'AWS_DEFAULT_PROFILE'];
  for (const key of removals) {
    assert.equal(env[key], null, `${key} must be removed in the actual create-terminal options`);
  }
  assert.deepEqual(Object.entries(env).filter(([, value]) => value === null).map(([key]) => key).sort(), [...removals].sort(),
    'only the four approved variables are removed');
  const expected: Readonly<Record<string, string>> = {
    AWS_ENDPOINT_URL: endpoint, AWS_ENDPOINT_URL_STS: endpoint,
    AWS_ENDPOINT_URL_SQS: endpoint, AWS_ENDPOINT_URL_S3: endpoint,
    AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
    AWS_REGION: region, AWS_DEFAULT_REGION: region,
    AWS_EC2_METADATA_DISABLED: 'true', AWS_PAGER: '',
  };
  for (const [key, value] of Object.entries(expected)) { assert.equal(env[key], value, key); }
};
