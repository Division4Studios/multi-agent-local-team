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
import type { CallUsage } from '../../shared/conversation';
import { createLineSplitter } from '../../shared/lineSplitter';
import type { LineSplitter } from '../../shared/lineSplitter';

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

/**
 * Splits stdout into NDJSON events. Bytes are decoded with a streaming UTF-8 decoder, so a character split across
 * chunks survives intact, and `end` processes a final line that has no trailing newline.
 */
export const eventReader = (onEvent: (event: unknown) => void): LineSplitter =>
  createLineSplitter((line) => {
    if (line.trim() !== '') {
      onEvent(parseLine(line));
    }
  });

const runProcess = async (command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> =>
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let result: unknown;
    const timer = setTimeout(() => child.kill(), options.timeoutMs);
    const reader = eventReader((event) => {
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
      reader.push(chunk);
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
      reader.end();
      resolvePromise({ code, result, stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(options.input);
  });

const firstString = (...values: readonly unknown[]): string => values.find(isString) ?? 'unknown error';

const count = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0);

/**
 * Tokens and cost from the final `result` event. Cache writes count as input; cache reads are reported separately
 * (they are much cheaper). Undefined if the CLI did not report usage.
 */
export const usageFrom = (result: unknown): CallUsage | undefined => {
  if (!isRecord(result) || !isRecord(result['usage'])) {
    return undefined;
  }
  const usage = result['usage'];
  const cost = result['total_cost_usd'];
  return {
    inputTokens: count(usage['input_tokens']) + count(usage['cache_creation_input_tokens']),
    outputTokens: count(usage['output_tokens']),
    cachedTokens: count(usage['cache_read_input_tokens']),
    costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : 0,
  };
};

/** Command-line arguments for one isolated call. `--effort` is passed unless the profile leaves the default. */
export const claudeArgs = (call: StructuredCall): string[] => [
  '-p',
  '--model', call.model,
  ...(call.effort === 'default' ? [] : ['--effort', call.effort]),
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

const extractStructuredOutput = ({ code, result, stderr }: ProcessResult): unknown => {
  if (!isRecord(result)) {
    throw new Error(`claude exited with ${String(code)} without a result: ${stderr.slice(0, 500)}`);
  }
  if (result['is_error'] === true || result['structured_output'] === undefined) {
    throw new Error(`claude returned an error: ${firstString(result['result'], result['subtype']).slice(0, 500)}`);
  }
  return result['structured_output'];
};

/**
 * The CLI gave up after the model's answers repeatedly failed the schema. Seen live: the model slips into another
 * tool-call syntax inside a long text field, swallowing the fields after it. It is a formatting failure, not an
 * answer, so the call is retried once as a fresh, isolated call. Any other error fails at once.
 */
export const isFormatFailure = (result: unknown): boolean =>
  isRecord(result) && result['subtype'] === 'error_max_structured_output_retries';

/** Usage across attempts: a failed attempt still used tokens, and the live log should show what the call cost. */
export const addUsage = (total: CallUsage | undefined, next: CallUsage | undefined): CallUsage | undefined =>
  total === undefined || next === undefined ? total ?? next : {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cachedTokens: total.cachedTokens + next.cachedTokens,
    costUsd: total.costUsd + next.costUsd,
  };

export class ClaudeCodeProvider implements ReviewProvider {
  public readonly name = 'claude';

  private readonly claudePath: string;

  public constructor(claudePath: string) {
    this.claudePath = claudePath;
  }

  public async callStructured(call: StructuredCall): Promise<unknown> {
    let result = await this.attempt(call);
    let usage = usageFrom(result.result);
    if (isFormatFailure(result.result)) {
      result = await this.attempt(call);
      usage = addUsage(usage, usageFrom(result.result));
    }
    if (usage !== undefined) {
      call.onUsage?.(usage);
    }
    return extractStructuredOutput(result);
  }

  private async attempt(call: StructuredCall): Promise<ProcessResult> {
    // A private (0700), unpredictably named, empty working directory per call: nothing from the reviewed repo is
    // in scope, and no other local user can pre-create or read it. MALT writes no files into it.
    const workDir = await mkdtemp(join(tmpdir(), 'malt-reviewer-'));
    const args = claudeArgs(call);
    const onEvent = (event: unknown): void => {
      call.onActivity?.();
      const text = streamedText(event);
      if (text !== undefined) {
        call.onText?.(text);
      }
    };
    try {
      return await runProcess(this.claudePath, args, { input: call.userPrompt, timeoutMs: call.timeoutMs, cwd: workDir, onEvent });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
