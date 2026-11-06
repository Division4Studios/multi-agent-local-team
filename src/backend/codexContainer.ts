/**
 * Codex calls, each in a throwaway container (`docker/codex`): no workspace or other mount, a read-only root
 * filesystem, all capabilities dropped, no privilege escalation, memory and process limits, and every Codex tool
 * switched off by the launcher. The request (MALT's static instructions, the redacted prompt and a strict-mode
 * schema) goes in on stdin; the answer comes back as one JSON line on stdout. The container is removed afterwards,
 * whatever happened. The image is built locally from files shipped inside the extension, tagged with their hash.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord, isString } from '../shared/guards';
import type { Effort } from '../shared/reviewProfiles';
import { dockerErrorMessage } from './dockerApi';
import type { DockerClient } from './dockerApi';
import { createTar } from './tar';

/** Codex's reasoning efforts; MALT's `max` is Codex's highest. */
export type CodexEffort = 'low' | 'medium' | 'high' | 'xhigh';

export const codexEffort = (effort: Effort): CodexEffort | undefined => {
  if (effort === 'default') {
    return undefined;
  }
  return effort === 'max' ? 'xhigh' : effort;
};

export interface CodexRequest {
  readonly instructions: string;
  readonly prompt: string;
  readonly schema: Readonly<Record<string, unknown>>;
  /** Omitted for Codex's own default model. */
  readonly model?: string;
  readonly effort?: CodexEffort;
}

export interface CodexRunOptions {
  readonly apiKey: string;
  /** The whole call's budget, image build included. */
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** What the runner needs from Docker (a narrower type, so tests can supply a fake engine). */
export type CodexDocker = Pick<DockerClient, 'attachStdin' | 'build' | 'inspect' | 'logs' | 'send' | 'sendJson'>;

const CANCELLED = 'Reviewer task cancelled';

/** The container: nothing from the workspace or the host, and only the key in its environment. */
export const codexContainerSpec = (image: string, apiKey: string): Record<string, unknown> => ({
  Image: image,
  User: 'node',
  Env: [`CODEX_API_KEY=${apiKey}`],
  AttachStdin: true,
  OpenStdin: true,
  StdinOnce: true,
  Labels: { 'dev.malt.role': 'codex' },
  HostConfig: {
    ReadonlyRootfs: true,
    Tmpfs: { '/tmp': 'rw,nosuid,size=128m,mode=1777', '/home/node': 'rw,nosuid,size=256m,mode=1777' },
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    Memory: 1_073_741_824,
    PidsLimit: 256,
  },
});

/** The launcher's answer: the last stdout line that is `{"output": …}` or `{"error": "…"}`. */
export const parseCodexOutput = (logs: string): unknown => {
  for (const line of logs.split('\n').reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(parsed) && Object.hasOwn(parsed, 'output')) {
      return parsed['output'];
    }
    if (isRecord(parsed) && isString(parsed['error'])) {
      throw new Error(parsed['error']);
    }
  }
  throw new Error('Codex ended without an answer');
};

const timeoutError = (timeoutMs: number): Error => new Error(`Codex did not answer within ${String(Math.round(timeoutMs / 1000))} s`);

/**
 * Checked before every step that could start work or send the prompt: a call cancelled or out of time while the
 * image was building (or the container starting) must never reach OpenAI.
 */
const checkLive = (options: CodexRunOptions, endsAt: number): void => {
  if (options.signal?.aborted === true) {
    throw new Error(CANCELLED);
  }
  if (Date.now() >= endsAt) {
    throw timeoutError(options.timeoutMs);
  }
};

/**
 * Settles with the reason when the call is cancelled (already, or later) or runs out of time; the caller then removes
 * the container.
 */
const deadline = async (endsAt: number, options: CodexRunOptions, done: Promise<unknown>): Promise<Error> =>
  await new Promise((resolve) => {
    const { signal } = options;
    const abort = (): void => { resolve(new Error(CANCELLED)); };
    if (signal?.aborted === true) {
      abort();
      return;
    }
    const timer = setTimeout(() => { resolve(timeoutError(options.timeoutMs)); }, Math.max(0, endsAt - Date.now()));
    signal?.addEventListener('abort', abort, { once: true });
    void done.finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }).catch(() => undefined);
  });

export class CodexContainer {
  private readonly client: CodexDocker;
  private readonly extensionRoot: string;
  private readonly log: (line: string) => void;
  private image: Promise<string> | undefined;

  public constructor(client: CodexDocker, extensionRoot: string, log: (line: string) => void) {
    this.client = client;
    this.extensionRoot = extensionRoot;
    this.log = log;
  }

  /** Runs one call in a new container and returns its JSON answer (still untrusted: the reviewer validates it). */
  public async run(request: CodexRequest, options: CodexRunOptions): Promise<unknown> {
    const endsAt = Date.now() + options.timeoutMs;
    checkLive(options, endsAt);
    const image = await this.ensureImage();
    checkLive(options, endsAt);
    const name = `malt-codex-${randomUUID()}`;
    const created = await this.client.sendJson('POST', `/containers/create?name=${name}`, codexContainerSpec(image, options.apiKey));
    if (created.status !== 201) {
      throw new Error(dockerErrorMessage(created));
    }
    try {
      await this.runCreated(name, request, options, endsAt);
      return parseCodexOutput(await this.client.logs(name, 'all'));
    } finally {
      await this.client.sendJson('DELETE', `/containers/${name}?force=1&v=1`).catch(() => undefined);
    }
  }

  private async runCreated(name: string, request: CodexRequest, options: CodexRunOptions, endsAt: number): Promise<void> {
    const stdin = await this.client.attachStdin(name);
    try {
      checkLive(options, endsAt);
      const started = await this.client.sendJson('POST', `/containers/${name}/start`);
      if (started.status !== 204) {
        throw new Error(dockerErrorMessage(started));
      }
      checkLive(options, endsAt);
      // One line: the launcher reads up to the newline, so stdin can stay open until the container exits.
      stdin.write(`${JSON.stringify(request)}\n`);
      const exited = this.client.send({ method: 'POST', path: `/containers/${name}/wait`, timeoutMs: options.timeoutMs + 60_000 });
      const response = await Promise.race([exited, deadline(endsAt, options, exited)]);
      if (response instanceof Error) {
        throw response;
      }
      if (response.status !== 200) {
        throw new Error(dockerErrorMessage(response));
      }
    } finally {
      stdin.destroy();
    }
  }

  private async ensureImage(): Promise<string> {
    this.image ??= this.buildImage().catch((error: unknown) => {
      this.image = undefined;
      throw error;
    });
    return await this.image;
  }

  private async buildImage(): Promise<string> {
    const folder = join(this.extensionRoot, 'docker', 'codex');
    const context = createTar([
      { name: 'Dockerfile', data: await readFile(join(folder, 'Dockerfile')) },
      { name: 'run.mjs', data: await readFile(join(folder, 'run.mjs')) },
    ]);
    const tag = `malt-codex:${createHash('sha256').update(context).digest('hex').slice(0, 12)}`;
    if ((await this.client.inspect('images', tag)) === undefined) {
      this.log(`Building Codex image ${tag} (first run can take a few minutes)`);
      await this.client.build(tag, context, this.log);
    }
    return tag;
  }
}
