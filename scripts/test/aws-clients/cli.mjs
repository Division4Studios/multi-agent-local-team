import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { CLI_IMAGE, CLI_VERSION, ROOT_ACCOUNT, ensure, failure } from './config.mjs';
import { runContainer } from './process.mjs';

const MISSING_QUEUE = ['QueueDoesNotExist', 'AWS.SimpleQueueService.NonExistentQueue'];

async function check(record, name, action) {
  try {
    const value = await action();
    record.checks.push({ name, status: 'passed' });
    return value;
  } catch (error) {
    record.checks.push({ name, status: 'failed', failure: failure(error) });
    throw error;
  }
}

function jsonOutput(result) {
  ensure(result.status === 0, 'CLI_EXIT', 'AWS CLI command failed');
  let value;
  try { value = result.stdout.trim() ? JSON.parse(result.stdout) : {}; }
  catch { ensure(false, 'CLI_OUTPUT', 'AWS CLI did not return JSON'); }
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'CLI_OUTPUT', 'AWS CLI output must be an object');
  return value;
}

function unit(result) {
  ensure(Object.keys(jsonOutput(result)).length === 0, 'CLI_OUTPUT', 'unit operation returned unexpected fields');
}

function serviceError(result, operation, codes) {
  ensure(result.status !== 0, 'CLI_ERROR', 'expected AWS CLI service failure');
  const match = /An error occurred \(([^)]+)\) when calling the (\w+) operation(?: \([^)]*\))?: ([\s\S]*)/u.exec(result.stderr);
  ensure(match && match[2] === operation && codes.includes(match[1]), 'CLI_ERROR', 'AWS CLI returned the wrong modeled service error');
  return match[3];
}

function caller(config, signal) {
  return (service, operation, input = {}, cleanup = false) => runContainer(config, CLI_IMAGE, [
    service, operation, '--cli-input-json', 'file:///dev/stdin', '--endpoint-url', config.endpoint,
    '--region', config.region, '--output', 'json', '--no-cli-pager', '--no-paginate',
    '--cli-connect-timeout', '3', '--cli-read-timeout', '5',
  ], { input: JSON.stringify(input), timeoutMs: 20_000, signal: cleanup ? undefined : signal });
}

async function identityAndQueue(record, state, call, signal) {
  await check(record, 'sts.GetCallerIdentity', async () => {
    const value = jsonOutput(await call('sts', 'get-caller-identity'));
    ensure(value.Account === ROOT_ACCOUNT && value.UserId === ROOT_ACCOUNT && value.Arn === `arn:aws:iam::${ROOT_ACCOUNT}:root`,
      'STS_IDENTITY', 'STS default root identity did not match the contract');
  });
  await check(record, 'sqs.CreateQueue', async () => {
    state.creationAttempted = true;
    const value = jsonOutput(await call('sqs', 'create-queue', { QueueName: state.name }));
    state.created = true;
    ensure(value.QueueUrl === state.url, 'QUEUE_URL', 'CreateQueue returned a noncanonical scoped URL');
  });
  await pause(1100, undefined, { signal }); // The documented create readiness may be accelerated, but need not be.
  await check(record, 'sqs.GetQueueUrl', async () => {
    const value = jsonOutput(await call('sqs', 'get-queue-url', { QueueName: state.name, QueueOwnerAWSAccountId: ROOT_ACCOUNT }));
    ensure(value.QueueUrl === state.url, 'QUEUE_URL', 'GetQueueUrl disagreed with the canonical creation URL');
  });
}

async function messageRoundTrip(record, state, call) {
  const sent = await check(record, 'sqs.SendMessage', async () => {
    const value = jsonOutput(await call('sqs', 'send-message', { QueueUrl: state.url, MessageBody: state.body, DelaySeconds: 0 }));
    ensure(typeof value.MessageId === 'string' && value.MessageId.length > 0 && value.MD5OfMessageBody === state.md5,
      'SEND', 'SendMessage identity or UTF-8 body MD5 did not match');
    return value;
  });
  const delivery = await check(record, 'sqs.ReceiveMessage.zeroVisibility', async () => {
    const value = jsonOutput(await call('sqs', 'receive-message', { QueueUrl: state.url, MaxNumberOfMessages: 1, VisibilityTimeout: 0, WaitTimeSeconds: 0 }));
    ensure(Array.isArray(value.Messages) && value.Messages.length === 1, 'RECEIVE', 'expected exactly one delivery');
    const message = value.Messages[0];
    ensure(message.Body === state.body && message.MD5OfBody === state.md5 && message.MessageId === sent.MessageId,
      'RECEIVE', 'received body, MD5 or delivery identity did not match the send');
    ensure(typeof message.ReceiptHandle === 'string' && message.ReceiptHandle.length > 0, 'RECEIVE', 'delivery has no opaque receipt');
    return message;
  });
  await check(record, 'sqs.DeleteMessage', async () => unit(await call('sqs', 'delete-message', { QueueUrl: state.url, ReceiptHandle: delivery.ReceiptHandle })));
  await check(record, 'sqs.ReceiveMessage.afterDelete', async () => {
    const value = jsonOutput(await call('sqs', 'receive-message', { QueueUrl: state.url, MaxNumberOfMessages: 1, VisibilityTimeout: 0, WaitTimeSeconds: 0 }));
    ensure(!Object.hasOwn(value, 'Messages'), 'DELETE_MESSAGE', 'deleted zero-visibility delivery was still present');
  });
}

async function deleteAndUnsupported(record, state, call) {
  await check(record, 'sqs.DeleteQueue', async () => unit(await call('sqs', 'delete-queue', { QueueUrl: state.url })));
  await check(record, 'sqs.GetQueueUrl.afterDelete', () => confirmQueueAbsent(state, call));
  await check(record, 'sqs.ListQueues.unsupported', async () => {
    const message = serviceError(await call('sqs', 'list-queues'), 'ListQueues', ['UnsupportedOperation']);
    ensure(message.includes('ListQueues') && /unsupported|not supported/iu.test(message), 'UNSUPPORTED', 'unsupported error must name ListQueues and explain unsupported behavior');
  });
}

async function confirmQueueAbsent(state, call, cleanup = false) {
  serviceError(await call('sqs', 'get-queue-url', { QueueName: state.name }, cleanup), 'GetQueueUrl', MISSING_QUEUE);
  state.created = false;
  state.deleted = true;
}

async function cleanupQueue(record, state, call) {
  await check(record, 'cleanup.DeleteQueue', async () => {
    const result = await call('sqs', 'delete-queue', { QueueUrl: state.url }, true);
    if (result.status === 0) unit(result);
    else serviceError(result, 'DeleteQueue', MISSING_QUEUE);
  });
  await check(record, 'cleanup.GetQueueUrl', () => confirmQueueAbsent(state, call, true));
}

export async function runCli(config, signal) {
  const name = `malt-cli-${randomUUID()}`;
  const body = `Original CLI fixture ${randomUUID()}: "quotes" \\ slash + % & 雪\nsecond line`;
  const state = { name, body, md5: createHash('md5').update(body, 'utf8').digest('hex'), url: `${config.endpoint}/${ROOT_ACCOUNT}/${config.region}/${name}`, created: false };
  const record = { client: 'aws-cli', image: CLI_IMAGE, version: null, queueName: name, checks: [], success: false };
  const call = caller(config, signal);
  try {
    await check(record, 'version', async () => {
      const result = await runContainer(config, CLI_IMAGE, ['--version'], { timeoutMs: 20_000, signal });
      const match = /^aws-cli\/([^\s]+)/u.exec(`${result.stdout}${result.stderr}`.trim());
      if (match && /^[0-9]+\.[0-9]+\.[0-9]+$/u.test(match[1])) record.version = match[1];
      ensure(result.status === 0 && record.version === CLI_VERSION, 'VERSION', 'actual AWS CLI version does not match the immutable pin');
    });
    await identityAndQueue(record, state, call, signal);
    await messageRoundTrip(record, state, call);
    await deleteAndUnsupported(record, state, call);
    record.success = true;
  } catch (error) { record.failure = failure(error); }
  finally {
    if (state.created) {
      try { await cleanupQueue(record, state, call); }
      catch (error) { record.cleanupFailure = failure(error); record.success = false; }
    }
  }
  record.queueCleanup = state.deleted ? 'confirmed' : state.creationAttempted ? 'unconfirmed' : 'not-created';
  return record;
}
