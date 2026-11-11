import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import { Failure, ensure, clientEnvironment } from './config.mjs';

function stopProcess(state, reason) {
  if (state.error || state.done) return;
  state.error = reason;
  state.child.kill('SIGKILL');
  state.killTimer = setTimeout(() => {
    state.child.stdout.destroy();
    state.child.stderr.destroy();
    state.child.stdin.destroy();
    state.child.unref();
    state.finish(new Failure('PROCESS_CLEANUP', 'child did not close within the force-kill deadline'));
  }, 2000);
}

function capture(state, stream, bytes) {
  state.size += bytes.length;
  if (state.size > 1024 * 1024) stopProcess(state, new Failure('OUTPUT_LIMIT', 'client output exceeded one MiB'));
  else state[stream].push(bytes);
}

export function runProcess(command, args, { input = '', timeoutMs = 20_000, signal, env = process.env } = {}) {
  ensure(!signal?.aborted, 'ABORTED', 'acceptance run was cancelled');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const state = { child, stdout: [], stderr: [], size: 0, done: false };
    const abort = () => stopProcess(state, new Failure('ABORTED', 'acceptance run was cancelled'));
    state.finish = (error, status) => {
      if (state.done) return;
      state.done = true;
      clearTimeout(state.timer);
      clearTimeout(state.killTimer);
      signal?.removeEventListener('abort', abort);
      const result = { status, stdout: Buffer.concat(state.stdout).toString('utf8'), stderr: Buffer.concat(state.stderr).toString('utf8') };
      if (error) reject(Object.assign(error, result));
      else resolve(result);
    };
    child.stdout.on('data', (bytes) => capture(state, 'stdout', bytes));
    child.stderr.on('data', (bytes) => capture(state, 'stderr', bytes));
    child.once('error', () => { state.error ??= new Failure('PROCESS_START', 'could not start the requested executable'); });
    child.once('close', (status, terminationSignal) => {
      const error = state.error ?? (terminationSignal ? new Failure('PROCESS_EXIT', 'client terminated by a signal') : undefined);
      state.finish(error, status);
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') stopProcess(state, new Failure('PROCESS_INPUT', 'could not deliver client stdin'));
    });
    state.timer = setTimeout(() => stopProcess(state, new Failure('TIMEOUT', 'client exceeded its execution deadline')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin.end(input);
  });
}

const docker = (args, options) => runProcess('docker', args, options);
const absent = (result, name) => result.status !== 0 && result.stderr.includes(`No such container: ${name}`);

async function removeOwned(name, owner) {
  const result = await docker(['inspect', '--type', 'container', '--format', '{{index .Config.Labels "malt.aws-client-owner"}}', name], { timeoutMs: 5000 });
  if (absent(result, name)) return;
  ensure(result.status === 0 && result.stdout.trim() === owner, 'CONTAINER_CLEANUP', 'could not establish owned-client cleanup identity');
  const removed = await docker(['rm', '--force', name], { timeoutMs: 5000 });
  ensure(removed.status === 0 || absent(removed, name), 'CONTAINER_CLEANUP', 'owned client container removal failed');
}

export async function inspectGateway(config, signal) {
  const result = await docker(['inspect', '--type', 'container', '--format', '{{json .State.Running}}', config.container], { timeoutMs: 5000, signal });
  ensure(result.status === 0 && result.stdout.trim() === 'true', 'GATEWAY', 'the explicitly supplied gateway container must already be running');
}

export function containerArguments(config, image, name, owner, args, entrypoint, network) {
  return ['run', '--rm', '--pull', 'never', '--name', name, '--label', `malt.aws-client-owner=${owner}`,
    '--network', network ?? `container:${config.container}`, '--read-only', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--cpus', '0.5',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16777216,uid=1000,gid=1000', '--interactive',
    ...Object.entries(clientEnvironment(config)).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    ...(entrypoint ? ['--entrypoint', entrypoint] : []), image, ...args];
}

export async function runContainer(config, image, args, options = {}) {
  const owner = randomUUID();
  const name = `malt-aws-client-${owner}`;
  let result;
  let error;
  try {
    result = await docker(containerArguments(config, image, name, owner, args, options.entrypoint, options.network), options);
  } catch (caught) { error = caught; }
  try {
    await removeOwned(name, owner);
    if (error) error.containerCleanup = 'confirmed';
  }
  catch (cleanup) {
    error = Object.assign(new Failure('CONTAINER_CLEANUP', 'owned container cleanup failed or could not be confirmed'), {
      stdout: result?.stdout ?? error?.stdout ?? '', stderr: '', cause: cleanup, containerCleanup: 'unconfirmed',
    });
  }
  if (error) throw error;
  return { ...result, containerCleanup: 'confirmed' };
}
