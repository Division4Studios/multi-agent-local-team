import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { BOTO3_VERSION, PYTHON_IMAGE, ensure, failure } from './config.mjs';
import { runContainer } from './process.mjs';

const STEPS = ['sts.GetCallerIdentity', 'sqs.CreateQueue', 'sqs.GetQueueUrl', 'sqs.SendMessage',
  'sqs.ReceiveMessage.zeroVisibility', 'sqs.DeleteMessage', 'sqs.ReceiveMessage.afterDelete',
  'sqs.DeleteQueue', 'sqs.GetQueueUrl.afterDelete', 'sqs.ListQueues.unsupported'];
const CLEANUP_STEPS = ['cleanup.DeleteQueue', 'cleanup.GetQueueUrl'];

const absenceVerified = (record) => record.checks.some(({ name, status }) => status === 'passed'
  && ['sqs.GetQueueUrl.afterDelete', 'cleanup.GetQueueUrl'].includes(name));

function acceptVersion(record, event) {
  ensure(record.version === null, 'VERSION', 'duplicate SDK version event');
  ensure(/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(event.boto3) && /^[0-9]+\.[0-9]+\.[0-9]+$/u.test(event.python), 'VERSION', 'invalid SDK version output');
  record.version = event.boto3;
  record.pythonVersion = event.python;
  ensure(event.boto3 === BOTO3_VERSION && /^3\.13\./u.test(event.python), 'VERSION', 'actual SDK versions do not match the pins');
}

function acceptEvent(record, state, event) {
  if (event.event === 'version') {
    acceptVersion(record, event);
  } else if (event.event === 'check') {
    ensure(record.version && [...STEPS, ...CLEANUP_STEPS].includes(event.name) && ['passed', 'failed'].includes(event.status), 'SDK_OUTPUT', 'invalid SDK check event');
    record.checks.push({ name: event.name, status: event.status });
  } else if (event.event === 'complete') {
    ensure(!state.completion, 'SDK_OUTPUT', 'duplicate SDK completion event');
    ensure(['confirmed', 'unconfirmed', 'not-created'].includes(event.queueCleanup), 'SDK_OUTPUT', 'invalid SDK cleanup result');
    state.completion = event;
  } else {
    ensure(event.event === 'fatal', 'SDK_OUTPUT', 'unknown SDK event');
    record.failure = { code: 'SDK_SETUP', message: 'SDK setup or version verification failed' };
  }
}

function parseEvent(line) {
  try { return JSON.parse(line); }
  catch { ensure(false, 'SDK_OUTPUT', 'SDK output contained an incomplete or invalid event'); }
}

function consumeOutput(record, text) {
  const state = {};
  try {
    for (const line of text.trim().split('\n').filter(Boolean)) acceptEvent(record, state, parseEvent(line));
    return state.completion;
  } finally {
    // A terminated stream may end mid-event; retain the earlier executed checks.
    const notCreated = state.completion?.queueCleanup === 'not-created'
      && !record.checks.some(({ name }) => name === 'sqs.CreateQueue');
    record.queueCleanup = absenceVerified(record) ? 'confirmed' : notCreated ? 'not-created' : 'unconfirmed';
  }
}

function verifyCompletion(record, result, completion, executionError, steps) {
  ensure(!executionError, 'SDK_RUN', 'SDK execution or container cleanup failed');
  ensure(result?.status === 0, 'SDK_RUN', 'SDK process did not exit successfully');
  ensure(completion?.success === true, 'SDK_RUN', 'SDK did not report successful completion');
  ensure(record.queueCleanup === 'confirmed', 'SDK_RUN', 'SDK queue cleanup is unconfirmed');
  ensure(!record.failure, 'SDK_RUN', 'SDK reported a setup failure');
  ensure(record.checks.length === steps.length, 'SDK_RUN', 'SDK check inventory did not match');
  ensure(record.checks.every((item, index) => item.status === 'passed' && item.name === steps[index]), 'SDK_RUN', 'SDK acceptance assertions failed or ran out of order');
}

async function invoke(config, caseData, signal, timeoutMs = 120_000) {
  const input = await readFile(new URL('./boto3-probe.py', import.meta.url), 'utf8');
  return runContainer(config, PYTHON_IMAGE, ['-', JSON.stringify(caseData)], { input, entrypoint: '/var/lang/bin/python', timeoutMs, signal });
}

async function executeSdk(record, config, caseData, signal, timeoutMs, steps) {
  let result;
  let executionError;
  try { result = await invoke(config, caseData, signal, timeoutMs); }
  catch (error) { executionError = error; }
  try {
    const completion = consumeOutput(record, result?.stdout ?? executionError?.stdout ?? '');
    verifyCompletion(record, result, completion, executionError, steps);
    record.success = true;
  } catch (error) { record.failure = failure(executionError ?? error); }
}

async function cleanupInterruptedSdk(record, config, caseData) {
  const created = record.checks.some(({ name, status }) => name === 'sqs.CreateQueue' && status === 'passed');
  if (!created || absenceVerified(record)) return;
  const cleanup = { version: null, checks: [], queueCleanup: 'unconfirmed', success: false };
  await executeSdk(cleanup, config, { ...caseData, cleanupOnly: true }, undefined, 20_000, CLEANUP_STEPS);
  record.cleanupChecks = cleanup.checks;
  record.cleanupOutcome = { success: cleanup.success, queueCleanup: cleanup.queueCleanup };
  if (cleanup.failure) record.cleanupFailure = cleanup.failure;
  record.queueCleanup = cleanup.queueCleanup === 'confirmed' ? 'confirmed' : 'unconfirmed';
}

export async function runSdk(config, signal) {
  const caseData = { queueName: `malt-sdk-${randomUUID()}`, body: `Original SDK fixture ${randomUUID()}: "quotes" \\ slash + % & 雪\nsecond line` };
  const record = { client: 'boto3', image: PYTHON_IMAGE, version: null, queueName: caseData.queueName, checks: [], queueCleanup: 'unconfirmed', success: false };
  await executeSdk(record, config, caseData, signal, 120_000, STEPS);
  await cleanupInterruptedSdk(record, config, caseData);
  return record;
}
