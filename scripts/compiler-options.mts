/** The native compiler runs only in an isolated Linux container, never as a host fallback. */
export type CompilerMode = 'compile' | 'check' | 'watch' | 'version' | 'sandbox-test';

export function parseCompilerMode(value: string | undefined): CompilerMode {
  if (value === 'compile' || value === 'check' || value === 'watch' || value === 'version' || value === 'sandbox-test') {
    return value;
  }
  throw new Error('Expected compiler mode: compile, check, watch, version, or sandbox-test');
}

export const SOURCE_MOUNTS = ['src', 'scripts', 'tsconfig.json', 'tsconfig.base.json'] as const;

export function compilerArguments(mode: CompilerMode): string[][] {
  if (mode === 'sandbox-test') {
    return [['/workspace/scripts/test/compiler-probe.mjs']];
  }
  if (mode === 'version') {
    return [['--version']];
  }
  if (mode === 'check') {
    return [['-p', '.', '--noEmit'], ['-p', 'scripts', '--noEmit']];
  }
  const args = ['-p', '.', '--outDir', '/workspace/out', '--noEmitOnError'];
  if (mode === 'watch') {
    args.push('--watch', '--preserveWatchOutput');
  }
  return [args];
}

export function containerArguments(name: string, user: string, mounts: readonly string[]): string[] {
  return ['run', '--rm', '--init', '--name', name, '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=128',
    '--memory=2g', '--memory-swap=2g', '--cpus=2', '--user', user,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--workdir', '/workspace',
    ...mounts.flatMap(mount => ['--mount', mount])];
}
