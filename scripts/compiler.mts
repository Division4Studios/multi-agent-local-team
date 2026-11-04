/** Trusted Docker launcher. No shell interpolation and no unsandboxed compiler fallback. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilerArguments, containerArguments, parseCompilerMode, SOURCE_MOUNTS } from './compiler-options.mts';
import type { CompilerMode } from './compiler-options.mts';

const root = await realpath(join(import.meta.dirname, '..'));

async function runDocker(args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: 'inherit', shell: false, windowsHide: true });
    child.once('error', (error: Error) => {
      reject(new Error('Docker with Linux containers is required for TypeScript 7 builds.', { cause: error }));
    });
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Docker ${args[0] ?? ''} failed (${signal ?? String(code)}). Check Docker is running in Linux mode.`));
      }
    });
  });
}

async function buildImage(): Promise<string> {
  const context = await mkdtemp(join(tmpdir(), 'malt-typescript-'));
  const hash = createHash('sha256');
  try {
    for (const file of ['package.json', 'package-lock.json', '.npmrc', 'scripts/compiler.Dockerfile']) {
      const content = await readFile(join(root, file));
      hash.update(file).update(content);
      await copyFile(join(root, file), join(context, file === 'scripts/compiler.Dockerfile' ? 'Dockerfile' : file));
    }
    const image = `malt-typescript:${hash.digest('hex').slice(0, 24)}`;
    await runDocker(['build', '--tag', image, context]);
    return image;
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

async function bindMount(relative: string, writable = false): Promise<string> {
  const expected = join(root, relative);
  const path = await realpath(expected);
  if (path !== expected || /[,"\r\n]/u.test(path)) {
    throw new Error(`Unsafe compiler mount path: ${relative}. Mounts must not be links or contain CSV delimiters.`);
  }
  return `type=bind,source=${path},target=/workspace/${relative}${writable ? '' : ',readonly'}`;
}

async function mountsFor(mode: CompilerMode): Promise<string[]> {
  const mounts = await Promise.all(SOURCE_MOUNTS.map(async file => await bindMount(file)));
  if (mode === 'compile' || mode === 'watch') {
    await mkdir(join(root, 'out'), { recursive: true });
    mounts.push(await bindMount('out', true));
  }
  return mounts;
}

async function runCompiler(image: string, mounts: readonly string[], args: readonly string[], probe: boolean): Promise<void> {
  const name = `malt-typescript-${randomUUID()}`;
  if (process.getuid?.() === 0) {
    throw new Error('Run the compiler launcher as a non-root user with Docker access.');
  }
  const user = process.getuid === undefined ? '1000:1000' : `${String(process.getuid())}:${String(process.getgid?.() ?? 1000)}`;
  const stop = (): void => {
    spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore', windowsHide: true });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const entrypoint = probe ? ['--entrypoint', 'node'] : [];
    await runDocker([...containerArguments(name, user, mounts), ...entrypoint, image, ...args]);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    stop();
  }
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) {
    throw new Error('Pass exactly one compiler mode; arbitrary compiler flags are not accepted.');
  }
  const mode = parseCompilerMode(process.argv[2]);
  const mounts = await mountsFor(mode);
  const image = await buildImage();
  for (const args of compilerArguments(mode)) {
    await runCompiler(image, mounts, args, mode === 'sandbox-test');
  }
}

main().catch((error: unknown) => {
  console.error(String(error));
  process.exitCode = 1;
});
