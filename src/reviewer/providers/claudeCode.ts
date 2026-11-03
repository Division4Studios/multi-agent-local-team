/**
 * Claude Code provider: runs `claude -p` as an isolated, tool-less, settings-less call.
 * - `--tools ""` and `--strict-mcp-config`: the model cannot run tools or MCP servers.
 * - `--setting-sources ""` plus a private, empty working directory: no project or user settings, hooks or
 *   CLAUDE.md from the reviewed repository are loaded, so a reviewed repo cannot run code through the reviewer.
 * - The system prompt is static and trusted (no repository text), so it is passed as an argument; no temp files.
 * - `--json-schema`: output is validated by the CLI, and again by MALT's own parsers.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord, isString } from '../../shared/guards';
import type { ReviewProvider, StructuredCall } from './provider';

const MAX_OUTPUT_BYTES = 5_000_000;

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ProcessOptions {
  readonly input: string;
  readonly timeoutMs: number;
  readonly cwd: string;
}

const runProcess = async (command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> =>
  await new Promise((resolvePromise, reject) => {
    const { input, timeoutMs, cwd } = options;
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const collect = (sink: Buffer[]) => (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(input);
  });

const firstString = (...values: readonly unknown[]): string => values.find(isString) ?? 'unknown error';

const extractStructuredOutput = (result: ProcessResult): unknown => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`claude exited with ${String(result.code)}: ${(result.stderr === '' ? result.stdout : result.stderr).slice(0, 500)}`);
  }
  if (!isRecord(parsed) || parsed['is_error'] === true || parsed['structured_output'] === undefined) {
    const detail = isRecord(parsed) ? firstString(parsed['result'], parsed['subtype']) : 'invalid output';
    throw new Error(`claude returned an error: ${detail.slice(0, 500)}`);
  }
  return parsed['structured_output'];
};

export class ClaudeCodeProvider implements ReviewProvider {
  public readonly name = 'claude';

  private readonly claudePath: string;

  public constructor(claudePath: string) {
    this.claudePath = claudePath;
  }

  public async callStructured(call: StructuredCall): Promise<unknown> {
    // A private (0700), unpredictably named, empty working directory per call: nothing from the reviewed repo is
    // in scope, and no other local user can pre-create or read it. MALT writes no files into it.
    const workDir = await mkdtemp(join(tmpdir(), 'malt-reviewer-'));
    const args = [
      '-p',
      '--model', call.model,
      '--system-prompt', call.systemPrompt,
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--no-session-persistence',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(call.schema),
    ];
    try {
      const result = await runProcess(this.claudePath, args, { input: call.userPrompt, timeoutMs: call.timeoutMs, cwd: workDir });
      return extractStructuredOutput(result);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
