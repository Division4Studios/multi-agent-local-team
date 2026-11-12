import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import { createServer as createTcpServer } from 'node:net';

export interface CapturedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface HttpFixture {
  readonly origin: string;
  readonly requests: CapturedRequest[];
  readonly connections: number;
  track<T>(operation: Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const replyJson = (response: ServerResponse, value: unknown, status = 200): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

export const httpFixture = async (reply: (request: CapturedRequest, response: ServerResponse) => void): Promise<HttpFixture> => {
  const requests: CapturedRequest[] = [];
  let connections = 0;
  const failures: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    request.on('error', () => { response.destroy(); });
    request.on('end', () => {
      const captured = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks) };
      requests.push(captured);
      try {
        reply(captured, response);
      } catch (error: unknown) {
        failures.push(error);
        response.destroy();
      }
    });
  });
  server.on('connection', () => { connections += 1; });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    get connections(): number { return connections; },
    track: async <T>(operation: Promise<T>): Promise<T> => {
      pending.push(Promise.allSettled([operation]));
      return await bounded(operation);
    },
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close(error => {
          if (error === undefined) { resolve(); } else { reject(error); }
        });
      });
      await bounded(Promise.all(pending));
      assert.deepEqual(failures, [], 'the synthetic HTTP fixture itself must not fail');
    },
  };
};

export const freePort = async (): Promise<number> => {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error === undefined) { resolve(); } else { reject(error); }
    });
  });
  return address.port;
};

export const bounded = async <T>(promise: Promise<T>, timeoutMs = 7_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((...[, reject]) => {
    timer = setTimeout(() => { reject(new Error('test fixture deadline exceeded')); }, timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
};
