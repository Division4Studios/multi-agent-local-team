import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseStrictJson } from '../../shared/aws/json';
import { parseScope } from '../../shared/aws/validation';
import type { AccountRegion, AwsCoverage, AwsQueueResource } from '../../shared/aws/types';
import { AwsError, invalid } from '../protocol/errors';
import { fields, record } from '../protocol/values';
import type { Gateway } from './gateway';
import { headerValues, readBody, singleHeader } from './body';
import { jsonResponse } from './responses';

export interface AdminActions {
  readonly gateway: Gateway;
  readonly coverage: AwsCoverage;
  readonly resources: () => readonly AwsQueueResource[];
  readonly reset: (scope: AccountRegion | 'all') => void;
  readonly save: () => Promise<void>;
  readonly close: () => Promise<void>;
}
const authenticated = (request: IncomingMessage, token: string): boolean => {
  const headers = headerValues(request, 'authorization');
  const expected = Buffer.from(`Bearer ${token}`);
  const received = Buffer.from(headers[0] ?? '');
  return headers.length === 1 && received.length === expected.length && timingSafeEqual(received, expected);
};
const mutationBody = async (request: IncomingMessage): Promise<Readonly<Record<string, unknown>>> => {
  if (singleHeader(request, 'content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { throw invalid('Admin mutations require application/json'); }
  const body = await readBody(request);
  try { return record(parseStrictJson(body)); } catch { throw invalid('Invalid admin JSON body'); }
};
const mutate = async (request: IncomingMessage, response: ServerResponse, actions: AdminActions): Promise<void> => {
  const body = await mutationBody(request);
  if (request.url === '/reset') {
    fields(body, ['scope']);
    const scope = body['scope'] === 'all' ? 'all' : parseScope(body['scope']);
    if (scope === undefined) { throw invalid('Invalid reset scope'); }
    actions.reset(scope);
    await actions.save();
    jsonResponse(response, 200, { reset: true });
  } else {
    fields(body, []);
    if (request.url === '/save') { await actions.save(); jsonResponse(response, 200, { saved: true }); }
    else {
      response.once('finish', () => { void actions.close().catch(() => { process.exitCode = 1; process.stderr.write('AWS shutdown flush failed.\n'); }); });
      jsonResponse(response, 200, { stopping: true });
    }
  }
};
export const adminHandler = (token: string, actions: AdminActions): ((request: IncomingMessage, response: ServerResponse) => Promise<void>) =>
  async (request, response): Promise<void> => {
    if (!authenticated(request, token)) { request.resume(); jsonResponse(response, 401, { message: 'Admin authentication required' }); return; }
    try {
      if (request.method === 'GET') { readRoute(request, response, actions); }
      else if (request.method === 'POST' && ['/save', '/reset', '/shutdown'].includes(request.url ?? '')) { await mutate(request, response, actions); }
      else { request.resume(); jsonResponse(response, 404, { message: 'Unknown admin route' }); }
    } catch (error) {
      request.resume();
      jsonResponse(response, error instanceof AwsError ? error.statusCode : 500, { message: error instanceof AwsError ? error.message : 'Admin operation failed' });
    }
  };
const readRoute = (request: IncomingMessage, response: ServerResponse, actions: AdminActions): void => {
  request.resume();
  switch (request.url) {
    case '/health': jsonResponse(response, 200, { status: 'running', requestCount: actions.gateway.requestCount, services: ['sqs', 'sts'] }); break;
    case '/resources': jsonResponse(response, 200, { resources: actions.resources() }); break;
    case '/coverage': jsonResponse(response, 200, actions.coverage); break;
    case '/traces': jsonResponse(response, 200, { traces: actions.gateway.traceSnapshot() }); break;
    case undefined:
    default: jsonResponse(response, 404, { message: 'Unknown admin route' });
  }
};
