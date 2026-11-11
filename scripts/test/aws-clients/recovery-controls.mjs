import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, mock, test } from 'node:test';
import { URL } from 'node:url';
import { BOTO3_VERSION, CLI_VERSION, Failure, ROOT_ACCOUNT } from './config.mjs';

// Synthetic fault controls only: no gateway, acceptance entry, receipt writer or
// compatibility credit. Mock the process boundary in this isolated test process.
let invoke;
const processMock = mock.module(new URL('./process.mjs', import.meta.url).href, {
  exports: { runContainer: (...args) => invoke(...args) },
});
after(() => processMock.restore());
const { runCli } = await import('./cli.mjs');
const { runSdk } = await import('./sdk.mjs');
const config = { endpoint: 'http://127.0.0.1:4566', region: 'us-east-1', container: '0'.repeat(64) };
const result = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' });
const cliError = (operation, code) => ({ status: 254, stdout: '',
  stderr: `An error occurred (${code}) when calling the ${operation} operation: synthetic-private-marker` });

function cliScenario({ failSend = false, fallbackAbsent = false, lookupError = false } = {}) {
  const state = { deletes: 0, lookups: 0, receives: 0 };
  const sqs = {
    'create-queue': (input) => {
      state.url = `${config.endpoint}/${ROOT_ACCOUNT}/${config.region}/${input.QueueName}`;
      return result({ QueueUrl: state.url });
    },
    'get-queue-url': () => {
      state.lookups++;
      if (state.deletes >= 2 && fallbackAbsent) return cliError('GetQueueUrl', 'QueueDoesNotExist');
      if (state.deletes && lookupError) return cliError('GetQueueUrl', 'InternalError');
      return result({ QueueUrl: state.url });
    },
    'send-message': (input) => {
      state.body = input.MessageBody;
      state.md5 = createHash('md5').update(state.body, 'utf8').digest('hex');
      return failSend ? cliError('SendMessage', 'InternalError') : result({ MessageId: 'synthetic-id', MD5OfMessageBody: state.md5 });
    },
    'receive-message': () => result(state.receives++ ? {} : { Messages: [{ MessageId: 'synthetic-id',
      Body: state.body, MD5OfBody: state.md5, ReceiptHandle: 'synthetic-receipt' }] }),
    'delete-message': () => result({}),
    'delete-queue': () => { state.deletes++; return result({}); },
  };
  invoke = async (_config, _image, args, options) => {
    if (args[0] === '--version') return { status: 0, stdout: `aws-cli/${CLI_VERSION}`, stderr: '' };
    if (args[0] === 'sts') return result({ Account: ROOT_ACCOUNT, UserId: ROOT_ACCOUNT, Arn: `arn:aws:iam::${ROOT_ACCOUNT}:root` });
    assert.ok(sqs[args[1]], `unexpected synthetic CLI operation ${args[1]}`);
    return sqs[args[1]](JSON.parse(options.input));
  };
  return state;
}

test('synthetic CLI delete acknowledgement cannot confirm cleanup while lookup still finds the queue', async () => {
  const state = cliScenario();
  const record = await runCli(config);
  assert.equal(record.success, false);
  assert.equal(record.failure.code, 'CLI_ERROR');
  assert.equal(record.queueCleanup, 'unconfirmed');
  assert.equal(state.deletes, 2, 'ownership must survive the contradictory lookup and trigger fallback');
  assert.equal(state.lookups, 3);
  assert.deepEqual(record.checks.slice(-2).map(({ name, status }) => ({ name, status })), [
    { name: 'cleanup.DeleteQueue', status: 'passed' }, { name: 'cleanup.GetQueueUrl', status: 'failed' },
  ]);
  assert.equal(record.cleanupFailure.code, 'CLI_ERROR');
  assert.ok(!JSON.stringify(record).includes('synthetic-private-marker'));
});

test('synthetic CLI failed lookup remains unconfirmed until fallback verifies absence', async () => {
  const state = cliScenario({ lookupError: true, fallbackAbsent: true });
  const record = await runCli(config);
  assert.equal(record.success, false, 'successful cleanup must not erase the acceptance failure');
  assert.equal(record.failure.code, 'CLI_ERROR');
  assert.equal(record.queueCleanup, 'confirmed');
  assert.equal(state.deletes, 2);
  assert.deepEqual(record.checks.slice(-2), [
    { name: 'cleanup.DeleteQueue', status: 'passed' }, { name: 'cleanup.GetQueueUrl', status: 'passed' },
  ]);
});

test('synthetic CLI early failure fallback also requires a missing-queue lookup', async () => {
  const state = cliScenario({ failSend: true, lookupError: true });
  const record = await runCli(config);
  assert.equal(record.success, false);
  assert.equal(record.failure.code, 'CLI_EXIT');
  assert.equal(record.queueCleanup, 'unconfirmed');
  assert.equal(state.deletes, 1);
  assert.equal(state.lookups, 2);
  assert.equal(record.checks.at(-1).name, 'cleanup.GetQueueUrl');
  assert.equal(record.checks.at(-1).status, 'failed');
});

const version = { event: 'version', boto3: BOTO3_VERSION, python: '3.13.0' };
const check = (name, status = 'passed') => ({ event: 'check', name, status, detail: 'synthetic-private-marker' });
const complete = (success, queueCleanup) => ({ event: 'complete', success, queueCleanup, detail: 'synthetic-private-marker' });
const output = (events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';
const sdkResult = (events, status = 1) => ({ status, stdout: output(events), stderr: 'synthetic-private-marker' });
const interrupted = (code, events, tail = '') => Object.assign(new Failure(code, 'controlled execution failure'), {
  stdout: output(events) + tail, stderr: 'synthetic-private-marker',
});

async function sdkScenario(acceptance, recovery) {
  let calls = 0;
  invoke = async (_config, _image, args) => {
    const cleanupOnly = JSON.parse(args[1]).cleanupOnly === true;
    assert.equal(cleanupOnly, calls++ > 0);
    assert.ok(calls <= 2, 'recovery must be bounded to one invocation');
    const value = cleanupOnly ? recovery : acceptance;
    assert.ok(value, 'unexpected recovery invocation');
    if (value instanceof Error) throw value;
    return value;
  };
  const record = await runSdk(config);
  assert.equal(record.success, false);
  assert.ok(!JSON.stringify(record).includes('synthetic-private-marker'));
  return { record, calls };
}

test('synthetic SDK recovery is not skipped after DeleteQueue passes but absence fails', async () => {
  const { record, calls } = await sdkScenario(
    sdkResult([version, check('sqs.CreateQueue'), check('sqs.DeleteQueue'), check('sqs.GetQueueUrl.afterDelete', 'failed'), complete(false, 'unconfirmed')]),
    sdkResult([version, check('cleanup.DeleteQueue'), check('cleanup.GetQueueUrl', 'failed'), complete(false, 'unconfirmed')]),
  );
  assert.equal(calls, 2);
  assert.equal(record.failure.code, 'SDK_RUN');
  assert.equal(record.queueCleanup, 'unconfirmed');
  assert.deepEqual(record.cleanupChecks, [
    { name: 'cleanup.DeleteQueue', status: 'passed' }, { name: 'cleanup.GetQueueUrl', status: 'failed' },
  ]);
  assert.deepEqual(record.cleanupOutcome, { success: false, queueCleanup: 'unconfirmed' });
});

test('synthetic SDK failed recovery retains sanitized checks and the original acceptance error', async () => {
  const { record, calls } = await sdkScenario(
    interrupted('TIMEOUT', [version, check('sqs.CreateQueue')]),
    sdkResult([version, check('cleanup.DeleteQueue', 'failed'), complete(false, 'unconfirmed')]),
  );
  assert.equal(calls, 2);
  assert.deepEqual(record.failure, { code: 'TIMEOUT', message: 'controlled execution failure' });
  assert.equal(record.cleanupFailure.code, 'SDK_RUN');
  assert.deepEqual(record.cleanupChecks, [{ name: 'cleanup.DeleteQueue', status: 'failed' }]);
  assert.deepEqual(record.cleanupOutcome, { success: false, queueCleanup: 'unconfirmed' });
});

test('synthetic SDK recovery execution errors preserve complete checks before truncated stdout', async () => {
  const { record } = await sdkScenario(
    interrupted('ABORTED', [version, check('sqs.CreateQueue')]),
    interrupted('CONTAINER_CLEANUP', [version, check('cleanup.DeleteQueue'), check('cleanup.GetQueueUrl', 'failed')], '{"event":"complete"'),
  );
  assert.deepEqual(record.failure, { code: 'ABORTED', message: 'controlled execution failure' });
  assert.equal(record.cleanupFailure.code, 'CONTAINER_CLEANUP');
  assert.equal(record.queueCleanup, 'unconfirmed');
  assert.deepEqual(record.cleanupChecks, [
    { name: 'cleanup.DeleteQueue', status: 'passed' }, { name: 'cleanup.GetQueueUrl', status: 'failed' },
  ]);
  assert.deepEqual(record.cleanupOutcome, { success: false, queueCleanup: 'unconfirmed' });
});

test('synthetic SDK recovery interrupted after deletion alone remains unconfirmed', async () => {
  const { record } = await sdkScenario(
    interrupted('ABORTED', [version, check('sqs.CreateQueue')]),
    interrupted('TIMEOUT', [version, check('cleanup.DeleteQueue')], '{"event":"check"'),
  );
  assert.equal(record.failure.code, 'ABORTED');
  assert.equal(record.cleanupFailure.code, 'TIMEOUT');
  assert.deepEqual(record.cleanupChecks, [{ name: 'cleanup.DeleteQueue', status: 'passed' }]);
  assert.deepEqual(record.cleanupOutcome, { success: false, queueCleanup: 'unconfirmed' });
  assert.equal(record.queueCleanup, 'unconfirmed');
});

test('synthetic SDK verified recovery absence survives a later execution error without erasing failure', async () => {
  const { record } = await sdkScenario(
    interrupted('ABORTED', [version, check('sqs.CreateQueue')]),
    interrupted('TIMEOUT', [version, check('cleanup.DeleteQueue'), check('cleanup.GetQueueUrl')], '{"event":"complete"'),
  );
  assert.equal(record.failure.code, 'ABORTED');
  assert.equal(record.cleanupFailure.code, 'TIMEOUT');
  assert.equal(record.queueCleanup, 'confirmed');
  assert.deepEqual(record.cleanupOutcome, { success: false, queueCleanup: 'confirmed' });
  assert.equal(record.cleanupChecks.length, 2);
});

test('synthetic SDK successful recovery never changes the failed acceptance outcome', async () => {
  const { record } = await sdkScenario(
    interrupted('TIMEOUT', [version, check('sqs.CreateQueue')]),
    sdkResult([version, check('cleanup.DeleteQueue'), check('cleanup.GetQueueUrl'), complete(true, 'confirmed')], 0),
  );
  assert.equal(record.failure.code, 'TIMEOUT');
  assert.equal(record.queueCleanup, 'confirmed');
  assert.deepEqual(record.cleanupOutcome, { success: true, queueCleanup: 'confirmed' });
  assert.ok(!Object.hasOwn(record, 'cleanupFailure'));
});

test('synthetic SDK partial acceptance skips recovery only after observed main or fallback absence', async () => {
  for (const absent of ['sqs.GetQueueUrl.afterDelete', 'cleanup.GetQueueUrl']) {
    const { record, calls } = await sdkScenario(interrupted('TIMEOUT', [version, check('sqs.CreateQueue'), check(absent)], '{"event":"complete"'));
    assert.equal(calls, 1);
    assert.equal(record.failure.code, 'TIMEOUT');
    assert.equal(record.queueCleanup, 'confirmed');
    assert.ok(!Object.hasOwn(record, 'cleanupChecks'));
  }
});
