import { request } from 'node:http';
import type { DockerFixture } from './awsDockerFixture';

export interface EngineReply {
  readonly status: number;
  readonly body: Buffer;
}

/** An independent HTTP caller for Engine-fixture controls, never a replacement backend. */
export const engineRequest = async (engine: DockerFixture, method: string, path: string, value?: unknown): Promise<EngineReply> =>
  await new Promise<EngineReply>((resolve, reject) => {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const req = request({ socketPath: engine.socketPath, method, path, headers: { 'content-type': 'application/json' } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      response.once('error', reject);
      response.once('aborted', () => { reject(new Error('control response aborted')); });
      response.once('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }); });
    });
    req.once('error', reject);
    req.setTimeout(5_000, () => { req.destroy(new Error('Engine control deadline')); });
    req.end(body);
  });

export const replyValue = (response: EngineReply): unknown => {
  const value: unknown = JSON.parse(response.body.toString('utf8'));
  return value;
};
