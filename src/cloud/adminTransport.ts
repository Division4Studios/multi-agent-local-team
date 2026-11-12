import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { httpOrigin } from '../shared/aws/validation';

export interface AdminEndpoint { readonly url: string; readonly token: string }
const LIMIT = 2 * 1024 * 1024;
const failure = (): Error => new Error('Local AWS admin request failed or returned invalid data.');
const validToken = (token: string): boolean => {
  for (let index = 0; index < token.length; index += 1) {
    const code = token.charCodeAt(index);
    if (code < 32 || code === 127) { return false; }
  }
  return token.length >= 32;
};

export const validateAdminEndpoint = (endpoint: AdminEndpoint): void => {
  try {
    const origin = httpOrigin(endpoint.url);
    if (new URL(origin).hostname !== '127.0.0.1' || !validToken(endpoint.token)) {
      throw failure();
    }
  } catch { throw new Error('Invalid Local AWS admin configuration.'); }
};

const validateResponse = (response: IncomingMessage): void => {
  const status = response.statusCode ?? 0;
  const type = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (status < 200 || status >= 300 || type !== 'application/json' || response.headers['content-encoding'] !== undefined) {
    response.destroy();
    throw failure();
  }
};
const readResponse = async (response: IncomingMessage): Promise<unknown> => {
  validateResponse(response);
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    if (!Buffer.isBuffer(chunk)) { throw failure(); }
    bytes += chunk.length;
    if (bytes > LIMIT) { response.destroy(); throw failure(); }
    parts.push(chunk);
  }
  if (!response.complete) { throw failure(); }
  const result: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
  return result;
};

/** Wall-clock deadline, bounded bytes, no redirects and no raw transport diagnostics. */
export const adminRequest = async (endpoint: AdminEndpoint, route: string, body?: unknown): Promise<unknown> => {
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, 5_000);
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const req = request(new URL(route, endpoint.url), {
        method: data === undefined ? 'GET' : 'POST', signal: controller.signal, agent: false,
        headers: { authorization: `Bearer ${endpoint.token}`,
          ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': data.length }) },
      }, response => { void readResponse(response).then(resolve, reject); });
      req.on('error', reject);
      req.end(data);
    });
  } catch { throw failure(); }
  finally { clearTimeout(timer); }
};
