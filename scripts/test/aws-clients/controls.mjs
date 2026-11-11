import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';
import { CLI_IMAGE, RECEIPT_KIND, configuration, clientEnvironment } from './config.mjs';
import { containerArguments, runProcess } from './process.mjs';
import { prepareReceipt } from './receipt.mjs';

const ENTRY = fileURLToPath(new URL('./run.mjs', import.meta.url));
const CONTAINER = 'a'.repeat(64);
const environment = () => ({ AWS_ENDPOINT_URL: 'http://127.0.0.1:4566', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
  AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1', AWS_EC2_METADATA_DISABLED: 'true' });
const argumentsFor = (receipt) => ['--container', CONTAINER, '--receipt', receipt];

async function temporary(t) {
  const base = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  const root = await fs.mkdtemp(path.join(base, 'malt-client-controls-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}

test('explicit invocation accepts the dedicated terminal environment and forwards only fixed client settings', async (t) => {
  const file = path.join(await temporary(t), 'receipt.json');
  const env = { ...environment(), AWS_ENDPOINT_URL_SQS: 'http://127.0.0.1:4566/', MALT_ADMIN_TOKEN: 'private-admin-marker', HTTP_PROXY: 'private-proxy-marker' };
  const config = configuration(argumentsFor(file), env);
  assert.equal(config.endpoint, 'http://127.0.0.1:4566');
  assert.equal(config.container, CONTAINER);
  const forwarded = clientEnvironment(config);
  assert.equal(forwarded.AWS_ACCESS_KEY_ID, 'test');
  assert.equal(forwarded.AWS_SECRET_ACCESS_KEY, 'test');
  assert.equal(forwarded.NO_PROXY, '*');
  assert.equal(forwarded.HTTP_PROXY, '');
  assert.ok(!Object.hasOwn(forwarded, 'MALT_ADMIN_TOKEN'));
  assert.ok(!Object.hasOwn(forwarded, 'AWS_PROFILE'));
});

test('argument validation rejects missing, duplicate, unknown, relative and non-ID inputs', async (t) => {
  const file = path.join(await temporary(t), 'receipt.json');
  for (const args of [[], ['--container', CONTAINER], [...argumentsFor(file), '--extra'],
    ['--receipt', file, '--receipt', file], ['--container', 'gateway-name', '--receipt', file],
    ['--container', 'a'.repeat(12), '--receipt', file], ['--container', `${CONTAINER};whoami`, '--receipt', file],
    ['--container', CONTAINER, '--receipt', 'relative.json']]) {
    assert.throws(() => configuration(args, environment()), { code: 'ARGUMENTS' });
  }
});

test('environment validation rejects remote or ambiguous endpoints and active credential sources', async (t) => {
  const args = argumentsFor(path.join(await temporary(t), 'receipt.json'));
  const invalid = [
    ...['https://127.0.0.1:4566', 'http://aws.example:4566', 'http://user@localhost:4566', 'http://127.0.0.1:4566/path',
      'http://127.0.0.1:4566?x=1', 'http://2130706433:4566', 'http://127.0.0.1:0', 'http://127.0.0.1:65536']
      .map((AWS_ENDPOINT_URL) => ({ AWS_ENDPOINT_URL })),
    { AWS_ACCESS_KEY_ID: 'real-key-marker' }, { AWS_SECRET_ACCESS_KEY: 'real-secret-marker' },
    { AWS_SESSION_TOKEN: 'token-marker' }, { AWS_SECURITY_TOKEN: 'token-marker' },
    { AWS_PROFILE: 'profile' }, { AWS_DEFAULT_PROFILE: 'profile' }, { AWS_EC2_METADATA_DISABLED: 'false' },
    { AWS_REGION: '', AWS_DEFAULT_REGION: '' }, { AWS_REGION: 'with spaces' }, { AWS_DEFAULT_REGION: 'eu-west-1' },
    { AWS_ENDPOINT_URL_STS: 'http://127.0.0.1:9999' },
  ];
  for (const patch of invalid) assert.throws(() => configuration(args, { ...environment(), ...patch }), { code: 'ENVIRONMENT' });
});

test('real entry refuses invalid arguments/environment before Docker and replaces an owned prior success', async (t) => {
  const root = await temporary(t);
  const host = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('AWS_') && name.toLowerCase() !== 'path'));
  for (const [label, patch, suffix, code] of [
    ['environment', { AWS_SESSION_TOKEN: 'private-session-marker' }, [], 'ENVIRONMENT'],
    ['arguments', {}, ['--unknown'], 'ARGUMENTS'],
  ]) {
    const file = path.join(root, `${label}.json`);
    await fs.writeFile(file, JSON.stringify({ kind: RECEIPT_KIND, runId: 'old-success', success: true }));
    const result = await runProcess(process.execPath, [ENTRY, ...argumentsFor(file), ...suffix], {
      env: { ...host, PATH: root, ...environment(), ...patch, MALT_ADMIN_TOKEN: 'private-admin-marker' }, timeoutMs: 5000,
    });
    assert.equal(result.status, 1);
    const text = await fs.readFile(file, 'utf8');
    const receipt = JSON.parse(text);
    assert.equal(receipt.success, false);
    assert.notEqual(receipt.runId, 'old-success');
    assert.equal(receipt.failure.code, code);
    assert.deepEqual(receipt.clients, []);
    assert.ok(!text.includes('private-session-marker') && !text.includes('private-admin-marker'));
    assert.ok(!text.includes('AWS_ACCESS_KEY_ID') && !text.includes('AWS_SECRET_ACCESS_KEY'));
  }
});

test('process timeout kills a real waiting child and awaits its exit', async () => {
  let failure;
  const start = Date.now();
  await assert.rejects(async () => {
    try {
      await runProcess(process.execPath, ['-e', 'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);'], { timeoutMs: 1000 });
    } catch (error) { failure = error; throw error; }
  }, { code: 'TIMEOUT' });
  assert.match(failure.stdout, /^[0-9]+$/u);
  assert.throws(() => process.kill(Number(failure.stdout), 0), { code: 'ESRCH' });
  assert.ok(Date.now() - start < 5000, 'termination exceeded the bounded cleanup allowance');
});

test('process cancellation kills and awaits a real child, and argument arrays preserve literal text', async () => {
  const literal = 'quotes " and \\ plus & ; $() 雪\nline two';
  const echo = await runProcess(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)));', literal]);
  assert.deepEqual(JSON.parse(echo.stdout), [literal]);
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  let failure;
  try {
    await assert.rejects(async () => {
      try {
        await runProcess(process.execPath, ['-e', 'process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);'], { signal: controller.signal });
      } catch (error) { failure = error; throw error; }
    }, { code: 'ABORTED' });
  } finally { clearTimeout(timer); }
  assert.match(failure.stdout, /^[0-9]+$/u);
  assert.throws(() => process.kill(Number(failure.stdout), 0), { code: 'ESRCH' });
});

test('receipt ownership refuses unrelated or hardlinked files without changing their bytes', async (t) => {
  const root = await temporary(t);
  const file = path.join(root, 'unrelated.json');
  await fs.writeFile(file, '{"kind":"other-document","success":true}');
  const before = await fs.readFile(file);
  await assert.rejects(() => prepareReceipt(file), { code: 'RECEIPT' });
  assert.deepEqual(await fs.readFile(file), before);
  const linked = path.join(root, 'linked.json');
  await fs.link(file, linked);
  await assert.rejects(() => prepareReceipt(linked), { code: 'RECEIPT' });
  assert.deepEqual(await fs.readFile(file), before);
});

test('client container arguments use the explicit namespace and required isolation without host mounts', async (t) => {
  const config = configuration(argumentsFor(path.join(await temporary(t), 'receipt.json')), environment());
  const args = containerArguments(config, CLI_IMAGE, 'owned-client', 'owner-marker', ['--version']);
  for (const [flag, value] of [['--network', `container:${CONTAINER}`], ['--user', '1000:1000'], ['--cap-drop', 'ALL'],
    ['--security-opt', 'no-new-privileges'], ['--memory', '256m'], ['--pids-limit', '64'], ['--cpus', '0.5'], ['--pull', 'never']]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.ok(args.includes('--rm') && args.includes('--read-only'));
  assert.ok(!args.includes('--mount') && !args.includes('--volume') && !args.includes('--privileged'));
  assert.equal(args.at(-2), CLI_IMAGE);
});
