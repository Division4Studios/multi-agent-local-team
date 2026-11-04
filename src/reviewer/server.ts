/**
 * HTTP API of the reviewer service. Every request needs the bearer token the extension generated at start-up.
 * Routes: GET /health, POST /review (block overview), POST /check (one rule), POST /consolidation (whole change),
 * POST /standards/scan (documents, code map and gaps).
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { PROTOCOL_VERSION, parseCheckRequest, parseConsolidationRequest, parseReviewRequest } from '../shared/protocol';
import type { ReviewRequest } from '../shared/protocol';
import type { ReviewService } from './service';
import { describeError, log } from './log';

const MAX_BODY_BYTES = 1_000_000;

class HttpError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const isAuthorized = (request: IncomingMessage, token: string): boolean => {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.headers.authorization ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Request body too large');
    }
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed;
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
};

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
};

const health = async (service: ReviewService): Promise<unknown> => {
  const [rules, gapsFound, architecture] = await Promise.all([service.rules(), service.gapCount(), service.architecture()]);
  return {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    provider: service.providerName,
    rulesLoaded: rules.length,
    gapsFound,
    modulesLoaded: architecture.modules.length,
    architectureScannedAt: architecture.generatedAt,
  };
};

const readRequest = async <T>(request: IncomingMessage, parse: (value: unknown) => T | undefined, name: string): Promise<T> => {
  const value = parse(await readJsonBody(request));
  if (value === undefined) {
    throw new HttpError(400, `Invalid ${name} request`);
  }
  return value;
};

const lines = (request: ReviewRequest): string =>
  `${request.filePath}:${String(request.startLine + 1)}-${String(request.endLine + 1)}`;

const route = async (service: ReviewService, request: IncomingMessage): Promise<unknown> => {
  const key = `${request.method ?? ''} ${request.url ?? ''}`;
  switch (key) {
    case 'GET /health':
      return await health(service);
    case 'POST /review': {
      const reviewRequest = await readRequest(request, parseReviewRequest, 'review');
      log(`review ${lines(reviewRequest)}`);
      return await service.review(reviewRequest);
    }
    case 'POST /check': {
      const checkRequest = await readRequest(request, parseCheckRequest, 'check');
      log(`check ${checkRequest.ruleId} ${lines(checkRequest)}`);
      return await service.check(checkRequest);
    }
    case 'POST /consolidation': {
      const consolidationRequest = await readRequest(request, parseConsolidationRequest, 'consolidation');
      log(`consolidation over ${String(consolidationRequest.blocks.length)} block(s)`);
      return { findings: await service.consolidation(consolidationRequest) };
    }
    case 'POST /standards/scan':
      log('standards scan started');
      return await service.scanStandards();
    default:
      throw new HttpError(404, 'Not found');
  }
};

export const createReviewerServer = (service: ReviewService, token: string): Server =>
  createServer((request, response) => {
    if (!isAuthorized(request, token)) {
      sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }
    route(service, request).then(
      (body) => {
        sendJson(response, 200, body);
      },
      (error: unknown) => {
        const status = error instanceof HttpError ? error.status : 500;
        log(`error ${String(status)}: ${describeError(error)}`);
        sendJson(response, status, { error: describeError(error) });
      },
    );
  });
