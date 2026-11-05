/**
 * Docker Engine API client over the local socket / named pipe, using only `node:http`.
 * No Docker CLI and no child processes: MALT never shells out to manage containers.
 */
import { request as httpRequest } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { isRecord, isString } from '../shared/guards';
import { createLineSplitter } from '../shared/lineSplitter';

export interface DockerResponse {
  readonly status: number;
  readonly body: Buffer;
}

interface RequestOptions {
  readonly method: string;
  readonly path: string;
  readonly body?: Buffer;
  readonly contentType?: string;
  readonly timeoutMs?: number;
  readonly onChunk?: (chunk: Buffer) => void;
}

export const defaultDockerSocket = (): string => {
  const fromEnv = process.env['DOCKER_HOST'];
  if (fromEnv?.startsWith('unix://') === true) {
    return fromEnv.slice('unix://'.length);
  }
  if (fromEnv?.startsWith('npipe://') === true) {
    return fromEnv.slice('npipe://'.length).replaceAll('/', '\\');
  }
  return process.platform === 'win32' ? '\\\\.\\pipe\\docker_engine' : '/var/run/docker.sock';
};

/**
 * Splits Docker's multiplexed log stream (8-byte frame headers) into text. Each stream (stdout, stderr) has its own
 * streaming UTF-8 decoder, so a character split across frames is decoded intact.
 */
export const demuxDockerLogs = (data: Buffer): string => {
  const decoders = new Map<number, StringDecoder>();
  const parts: string[] = [];
  let offset = 0;
  while (offset + 8 <= data.length) {
    const stream = data.readUInt8(offset);
    const size = data.readUInt32BE(offset + 4);
    const decoder = decoders.get(stream) ?? new StringDecoder('utf8');
    decoders.set(stream, decoder);
    parts.push(decoder.write(data.subarray(offset + 8, offset + 8 + size)));
    offset += 8 + size;
  }
  for (const decoder of decoders.values()) {
    parts.push(decoder.end());
  }
  return parts.join('');
};

const parseJson = (body: Buffer): unknown => {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return parsed;
  } catch {
    return undefined;
  }
};

export const dockerErrorMessage = (response: DockerResponse): string => {
  const parsed = parseJson(response.body);
  const message = isRecord(parsed) && isString(parsed['message']) ? parsed['message'] : response.body.toString('utf8');
  return `Docker API ${String(response.status)}: ${message.slice(0, 500)}`;
};

export class DockerClient {
  private readonly socketPath: string;

  public constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  public async send(options: RequestOptions): Promise<DockerResponse> {
    return await new Promise((resolvePromise, reject) => {
      const headers: Record<string, string | number> = {};
      if (options.body !== undefined) {
        headers['content-type'] = options.contentType ?? 'application/json';
        headers['content-length'] = options.body.length;
      }
      const req = httpRequest(
        { socketPath: this.socketPath, method: options.method, path: options.path, headers, timeout: options.timeoutMs ?? 30_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => {
            options.onChunk?.(chunk);
            chunks.push(chunk);
          });
          res.on('end', () => {
            resolvePromise({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Docker API timed out: ${options.method} ${options.path}`)));
      req.on('error', reject);
      req.end(options.body);
    });
  }

  public async sendJson(method: string, path: string, body?: unknown): Promise<DockerResponse> {
    return await this.send(body === undefined ? { method, path } : { method, path, body: Buffer.from(JSON.stringify(body)) });
  }

  public async ping(): Promise<boolean> {
    try {
      const response = await this.send({ method: 'GET', path: '/_ping', timeoutMs: 3_000 });
      return response.status === 200;
    } catch {
      return false;
    }
  }

  /** The engine's `/info` (how and where it runs), or undefined if it cannot be read. */
  public async info(): Promise<unknown> {
    try {
      const response = await this.sendJson('GET', '/info');
      return response.status === 200 ? parseJson(response.body) : undefined;
    } catch {
      return undefined;
    }
  }

  public async inspect(kind: 'images' | 'containers', name: string): Promise<unknown> {
    const response = await this.sendJson('GET', `/${kind}/${encodeURIComponent(name)}/json`);
    if (response.status === 404) {
      return undefined;
    }
    if (response.status !== 200) {
      throw new Error(dockerErrorMessage(response));
    }
    return parseJson(response.body);
  }

  /** Builds an image from a tar context, streaming build output lines to `onLog`. */
  public async build(tag: string, context: Buffer, onLog: (line: string) => void): Promise<void> {
    let buildError: string | undefined;
    const lines = createLineSplitter((line) => {
      const event = parseJson(Buffer.from(line));
      if (isRecord(event) && isString(event['stream'])) {
        onLog(event['stream'].trimEnd());
      } else if (isRecord(event) && isString(event['error'])) {
        buildError = event['error'];
      }
    });
    const response = await this.send({
      method: 'POST',
      path: `/build?t=${encodeURIComponent(tag)}&rm=1&forcerm=1`,
      body: context,
      contentType: 'application/x-tar',
      timeoutMs: 900_000,
      onChunk: (chunk) => {
        lines.push(chunk);
      },
    });
    lines.end();
    if (response.status !== 200 || buildError !== undefined) {
      throw new Error(buildError ?? dockerErrorMessage(response));
    }
  }

  public async logs(container: string, tail: number): Promise<string> {
    const response = await this.send({
      method: 'GET',
      path: `/containers/${encodeURIComponent(container)}/logs?stdout=1&stderr=1&tail=${String(tail)}`,
    });
    return response.status === 200 ? demuxDockerLogs(response.body) : dockerErrorMessage(response);
  }
}
