import { Buffer } from 'node:buffer';
import type { IncomingMessage } from 'node:http';
import { AwsError, invalid } from '../protocol/errors';

export const BODY_LIMIT = 2 * 1024 * 1024;
export const headerValues = (request: IncomingMessage, name: string): readonly string[] => {
  const result: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const value = request.rawHeaders[index + 1];
    if (request.rawHeaders[index]?.toLowerCase() === name && value !== undefined) { result.push(value); }
  }
  return result;
};
export const singleHeader = (request: IncomingMessage, name: string): string | undefined => {
  const values = headerValues(request, name);
  if (values.length > 1) { throw invalid(`Repeated ${name} header`); }
  return values[0];
};
export const readBody = async (request: IncomingMessage): Promise<string> => {
  const encoding = singleHeader(request, 'content-encoding');
  if (encoding !== undefined && encoding !== 'identity') { request.resume(); throw invalid('Unsupported content encoding'); }
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = (): void => { request.off('data', data); request.off('end', end); request.off('error', fail); request.off('aborted', abort); };
    const fail = (error: Error): void => { cleanup(); reject(error); };
    const abort = (): void => { fail(invalid('Request body interrupted')); };
    const data = (chunk: unknown): void => {
      if (!Buffer.isBuffer(chunk)) { fail(invalid('Invalid body encoding')); return; }
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(new AwsError('RequestEntityTooLarge', 'Request body exceeds the 2 MiB limit', 413));
        request.resume();
        return;
      }
      chunks.push(chunk);
    };
    const end = (): void => { cleanup(); resolve(Buffer.concat(chunks)); };
    request.on('data', data); request.once('end', end); request.once('error', fail); request.once('aborted', abort);
  });
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw invalid('Malformed UTF-8 body'); }
};
