/**
 * Claude Code provider: runs `claude -p` as an isolated, tool-less, settings-less call.
 * - `--tools ""` and `--strict-mcp-config`: the model cannot run tools or MCP servers.
 * - `--setting-sources ""` plus a private, empty working directory: no project or user settings, hooks or
 *   CLAUDE.md from the reviewed repository are loaded, so a reviewed repo cannot run code through the reviewer.
 * - The system prompt is static and trusted (no repository text), so it is passed as an argument; no temp files.
 * - `--json-schema`: output is validated by the CLI, and again by MALT's own parsers.
 * - `--output-format stream-json`: the answer streams in as it is written (for the live log); only the final
 *   `result` event's schema-validated `structured_output` is returned.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRecord, isString } from '../../shared/guards';
import type { ReviewProvider, StructuredCall } from './provider';

const MAX_OUTPUT_BYTES = 20_000_000;
const MAX_STDERR_BYTES = 100_000;

interface ProcessResult {
  readonly code: number | null;
  readonly result: unknown;
  readonly stderr: string;
}

interface ProcessOptions {
  readonly input: string;
  readonly timeoutMs: number;
  readonly cwd: string;
  readonly onEvent: (event: unknown) => void;
}

const parseLine = (line: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed;
  } catch {
    return undefined;
  }
};

/** Streamed answer text: plain text deltas, or the structured answer's JSON as it is generated. */
export const streamedText = (event: unknown): string | undefined => {
  if (!isRecord(event) || event['type'] !== 'stream_event' || !isRecord(event['event'])) {
    return undefined;
  }
  const delta = event['event']['delta'];
  if (!isRecord(delta)) {
    return undefined;
  }
  const text = delta['text'] ?? delta['partial_json'];
  return isString(text) ? text : undefined;
};

/** Splits stdout into NDJSON lines (handling chunk boundaries) and hands each parsed event on. */
const lineReader = (onEvent: (event: unknown) => void): ((chunk: Buffer) => void) => {
  let pending = '';
  return (chunk: Buffer): void => {
    const lines = (pending + chunk.toString('utf8')).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() !== '') {
        onEvent(parseLine(line));
      }
    }
  };
};

const runProcess = async (command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> =>
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let result: unknown;
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    const read = lineReader((event) => {
      if (isRecord(event) && event['type'] === 'result') {
        result = event;
      }
      options.onEvent(event);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill();
        return;
      }
      read(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_STDERR_BYTES) {
        stderr.push(chunk);
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, result, stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(options.input);
  });

const firstString = (...values: readonly unknown[]): string => values.find(isString) ?? 'unknown error';

const extractStructuredOutput = ({ code, result, stderr }: ProcessResult): unknown => {
  if (!isRecord(result)) {
    throw new Error(`claude exited with ${String(code)} without a result: ${stderr.slice(0, 500)}`);
  }
  if (result['is_error'] === true || result['structured_output'] === undefined) {
    throw new Error(`claude returned an error: ${firstString(result['result'], result['subtype']).slice(0, 500)}`);
  }
  return result['structured_output'];
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
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--json-schema', JSON.stringify(call.schema),
    ];
    const onEvent = (event: unknown): void => {
      const text = streamedText(event);
      if (text !== undefined) {
        call.onText?.(text);
      }
    };
    try {
      const result = await runProcess(this.claudePath, args, { input: call.userPrompt, timeoutMs: call.timeoutMs, cwd: workDir, onEvent });
      return extractStructuredOutput(result);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
