import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { URL } from 'node:url';
import { PYTHON_IMAGE } from './config.mjs';
import { runContainer } from './process.mjs';

// Explicit preparation controls, never auto-discovered or credited as AWS calls.
// No gateway, image pull, version re-probe, or external network is involved.
const config = { container: '0'.repeat(64), endpoint: 'http://127.0.0.1:4566', region: 'us-east-1' };

test('pinned Python parses the SDK fixture with networking disabled', async () => {
  const input = await readFile(new URL('./boto3-probe.py', import.meta.url), 'utf8');
  const result = await runContainer(config, PYTHON_IMAGE, ['-m', 'ast'], {
    input, network: 'none', entrypoint: '/var/lang/bin/python', timeoutMs: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.containerCleanup, 'confirmed');
});

test('SDK connection failures never claim confirmed queue cleanup', async () => {
  const source = await readFile(new URL('./boto3-probe.py', import.meta.url), 'utf8');
  const control = `
from botocore.exceptions import EndpointConnectionError
probe = Probe({"queueName": "malt-sdk-rejection-control", "body": "original failure control"})
try:
    require(probe.run() is False, "unreachable STS must fail")
    try:
        check("sqs.CreateQueue", probe.create)
    except EndpointConnectionError:
        pass
    else:
        raise AssertionError("unreachable CreateQueue must fail")
    require(probe.run() is False, "unreachable STS must still fail")
finally:
    probe.sts.close()
    probe.sqs.close()
`;
  const result = await runContainer(config, PYTHON_IMAGE, ['-'], {
    input: `__name__ = "preparation_control"\n${source}\n${control}`,
    network: 'none', entrypoint: '/var/lang/bin/python', timeoutMs: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.containerCleanup, 'confirmed');
  const events = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.filter(({ event }) => event === 'complete'), [
    { event: 'complete', success: false, queueCleanup: 'not-created' },
    { event: 'complete', success: false, queueCleanup: 'unconfirmed' },
  ]);
  assert.deepEqual(events.filter(({ event }) => event === 'check'), [
    { event: 'check', name: 'sts.GetCallerIdentity', status: 'failed' },
    { event: 'check', name: 'sqs.CreateQueue', status: 'failed' },
    { event: 'check', name: 'sts.GetCallerIdentity', status: 'failed' },
  ]);
});

test('synthetic Python recovery controls require verified queue absence and retain failure evidence', async () => {
  const source = await readFile(new URL('./boto3-probe.py', import.meta.url), 'utf8');
  const controls = await readFile(new URL('./recovery-controls.py', import.meta.url), 'utf8');
  const result = await runContainer(config, PYTHON_IMAGE, ['-'], {
    input: `__name__ = "preparation_control"\n${source}\n${controls}`,
    network: 'none', entrypoint: '/var/lang/bin/python', timeoutMs: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Ran 6 tests[\s\S]*OK/u);
  assert.equal(result.containerCleanup, 'confirmed');
});

test('real owned container timeout is followed by awaited confirmed removal', async () => {
  let failure;
  const start = Date.now();
  await assert.rejects(async () => {
    try {
      await runContainer(config, PYTHON_IMAGE, ['-'], { network: 'none', entrypoint: '/var/lang/bin/python', timeoutMs: 5000,
        input: 'import time\nprint("owned-container-ready", flush=True)\ntime.sleep(60)\n' });
    } catch (error) { failure = error; throw error; }
  }, { code: 'TIMEOUT' });
  assert.match(failure.stdout, /owned-container-ready/u);
  assert.equal(failure.containerCleanup, 'confirmed');
  assert.ok(Date.now() - start < 20_000, 'owned container cleanup exceeded its bounded allowance');
});
