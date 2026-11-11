// Test-only process boundary. Reporter cases always import the real public seam;
// the two explicit harness modes exercise IPC/termination without writing evidence.
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setInterval } from 'node:timers';

const mode = process.argv[2];
const pending = new Map();
let sequence = 0;
const errorRecord = (error) => ({ name: error?.name ?? 'Error', message: error?.message ?? String(error),
  stack: error?.stack, code: error?.code });
const send = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));

async function* envelopes() {
  for (;;) {
    const id = ++sequence;
    const response = Promise.withResolvers();
    pending.set(id, response);
    await send({ type: 'next', id });
    const result = await response.promise;
    if (result.done) return;
    yield result.value;
  }
}

async function control(runtimeRoot) {
  if (mode === 'stall-control') {
    const path = join(runtimeRoot, 'aws', 'harness-active');
    appendFileSync(path, 'started\n');
    setInterval(() => appendFileSync(path, 'still active\n'), 20);
    await send({ type: 'started' });
    return new Promise(() => {});
  }
  const path = join(runtimeRoot, 'aws', 'z.js');
  const before = await readFile(path, 'utf8');
  const events = [];
  let first;
  for await (const event of envelopes()) {
    if (events.length === 0) first = await readFile(path, 'utf8');
    events.push(event);
  }
  return { before, first, events };
}

try {
  let write;
  if (mode === 'reporter') {
    ({ writeTestEvidence: write } = await import('../../aws-evidence-reporter.mts'));
    if (typeof write !== 'function') throw new TypeError('writeTestEvidence must be a function');
  } else if (!['stall-control', 'consume-control'].includes(mode)) throw new Error('unknown reporter harness mode');
  process.on('message', (message) => {
    if (message.type === 'event') {
      const response = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) response.reject(Object.assign(new Error(message.error.message), message.error));
      else response.resolve(message.result);
    } else if (message.type === 'run') {
      const run = async () => {
        try {
          const value = mode === 'reporter' ? await write(envelopes(), message.runtimeRoot) : await control(message.runtimeRoot);
          await send({ type: 'result', status: 'fulfilled', value });
        } catch (error) {
          await send({ type: 'result', status: 'rejected', error: errorRecord(error) });
        }
      };
      run().catch(() => process.exit(1));
    }
  });
  await send({ type: 'ready' });
} catch (error) {
  await send({ type: 'load-error', error: errorRecord(error) });
  process.disconnect();
}
