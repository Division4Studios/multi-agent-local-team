import { Buffer } from 'node:buffer';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { URL } from 'node:url';
import { deadline } from './http-helpers.mjs';

export const fixtureDigest = 'ccb65573ce9c74d5704ca21a3d3fd1e313b60727fc03092811d34ca4ef7ebad2';
export const digestFiles = [
  ['aws/z.js', 'exports.z = 2;\n'],
  ['aws/nested/caf\u00e9.js', 'module.exports = "\u2603";\r\n'],
  ['shared/base.js', Buffer.from([0, 255, 1, 10])],
];
// fixtureDigest was computed once over the explicit canonical byte stream;
// no second filesystem-inventory/digest implementation is embedded in the tests.
export async function evidenceTemp(t) {
  const base = process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  const root = await mkdtemp(join(base, 'malt-evidence-supplement-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return root;
}

export async function digestTree(root, reverse = false) {
  await mkdir(join(root, 'aws'), { recursive: true });
  await mkdir(join(root, 'shared'), { recursive: true });
  for (const [path, bytes] of reverse ? [...digestFiles].reverse() : digestFiles) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), bytes);
  }
  await writeFile(join(root, 'aws', 'test-evidence.json'), '{"ignored":true}');
  await writeFile(join(root, 'shared', 'notes.txt'), 'ignored asset');
  await writeFile(join(root, 'sibling.js'), 'ignored outside aws/shared');
}

export const passName = 'aws[sqs.SendMessage,sqs.ReceiveMessage;protocol] original event fixture';
export const secondPassName = 'aws[sts.GetCallerIdentity;unit] another event fixture';
export const passEvent = (name = passName, overrides = {}) => ({ type: 'test:pass', data: {
  name, nesting: 0, testNumber: 1, file: '/synthetic/events.test.mjs', line: 1, column: 1,
  details: { duration_ms: 1, type: 'test' }, ...overrides,
} });
export const summaryEvent = (overrides = {}) => ({ type: 'test:summary', data: {
  success: true, duration_ms: 1,
  counts: { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0, topLevel: 1 },
  ...overrides,
} });
export const expectedPass = { id: passName, operations: ['sqs.ReceiveMessage', 'sqs.SendMessage'], kind: 'protocol' };
export const expectedSecondPass = { id: secondPassName, operations: ['sts.GetCallerIdentity'], kind: 'unit' };

// Original minimal Node fixtures, not AWS behavior or contributing evidence.
// Fields are sourced from original TestsStream envelopes, following Node 24's
// documented test:pass, test:fail, test:interrupted and cumulative test:summary:
// https://nodejs.org/docs/latest-v24.x/api/test.html#class-testsstream
export async function originalEvents(t, fail = false) {
  const root = await evidenceTemp(t);
  const path = join(root, 'original-events.mjs');
  const source = `import { test, suite } from 'node:test';
test(${JSON.stringify(secondPassName)}, () => {});
test(${JSON.stringify(passName)}, () => {});
suite('aws[sqs.CreateQueue;workflow] suite is not evidence', () => { test('ordinary inner case', () => {}); });
test('aws[sqs.DeleteQueue;lifecycle] skip is not evidence', { skip: 'synthetic skip' }, () => {});
test('aws[sqs.DeleteMessage;unit] todo is not evidence', { todo: 'synthetic todo' }, () => {});
test('aws[sqs.GetQueueUrl;unit] expected failure is not evidence', { expectFailure: true }, () => { throw new Error('expected fixture failure'); });
test('ordinary test', () => { ${fail ? "throw new Error('deliberate ordinary failure');" : ''} });
`;
  await writeFile(path, source);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = fork(new URL('./evidence-stream-probe.mjs', import.meta.url), [path], {
    env, execArgv: [], serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await deadline(exited, 2000, 'event probe cleanup');
  });
  const events = [];
  let stderr = '';
  child.on('message', (event) => events.push(event));
  child.stderr.on('data', (bytes) => { stderr = `${stderr}${bytes}`.slice(-4000); });
  const [code, signal] = await deadline(once(child, 'exit'), 5000, 'original Node TestsStream fixture');
  if (code !== 0) throw new Error(`Node event probe exited ${signal ?? code}: ${stderr}`);
  return events;
}
