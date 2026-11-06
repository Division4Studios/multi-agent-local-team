/**
 * HTTP API of the reviewer service. Every request needs the bearer token the extension generated at start-up.
 * Routes: GET /health, POST /review (block overview), POST /check (one rule), POST /consolidation (whole change),
 * POST /standards/scan (documents, code map and gaps), POST /standards/investigate (deeper review of one recorded gap),
 * GET /events (live conversation stream, not persisted).
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { PROTOCOL_VERSION, parseCheckRequest, parseConsolidationRequest, parseReviewRequest } from '../shared/protocol';
import type { ReviewRequest } from '../shared/protocol';
import { UnknownRuleError } from './service';
import type { ReviewService } from './service';
import { ConversationLog } from './conversations';
import { log } from './log';
import { redactSecrets } from './redact';
import { isRecord } from '../shared/guards';
import { parseDiscussion } from '../shared/understanding';
import { isGapId } from '../shared/investigation';
import { parseDelegatedResult, parseDelegatedText } from '../shared/delegation';
import { Delegation } from './delegation';

const MAX_BODY_BYTES = 1_000_000;

class HttpError extends Error {
  public readonly status: number;

  public constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * What a failed request may report, in its response and in the log: the server's own HTTP errors as written, any
 * other error's message with secrets redacted (a model call's error can quote CLI output), and never a stack or a
 * thrown non-Error value.
 */
const publicMessage = (error: unknown): string => {
  if (error instanceof HttpError) {
    return error.message;
  }
  return error instanceof Error ? redactSecrets(error.message) : 'Internal reviewer error';
};

const isAuthorized =(request: IncomingMessage, token: string): boolean => {
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

/** The body may only name a recorded gap by id; the service looks the gap itself up. */
const investigate = async (service: ReviewService, request: IncomingMessage): Promise<unknown> => {
  const body = await readJsonBody(request);
  const id = isRecord(body) ? body['gapId'] : undefined;
  if (!isGapId(id)) {
    throw new HttpError(400, 'Invalid investigation request');
  }
  log(`gap investigation ${id}`);
  return await service.investigateGap(id);
};

const lines = (request: ReviewRequest): string =>
  `${request.filePath}:${String(request.startLine + 1)}-${String(request.endLine + 1)}`;

/** How long `GET /model-calls` waits for a call before answering with none (the extension then asks again). */
export const MODEL_CALL_WAIT_MS = 25_000;

/**
 * Delegated calls (`delegation.ts`): the extension takes calls, streams their text and posts their answers. The
 * answer is untrusted model output, validated by the same parsers as any provider's.
 */
const delegationRoute = async (delegation: Delegation, key: string, request: IncomingMessage): Promise<unknown> => {
  switch (key) {
    case 'GET /model-calls':
      return { calls: await delegation.take(MODEL_CALL_WAIT_MS) };
    case 'POST /model-calls/result': {
      const result = await readRequest(request, parseDelegatedResult, 'model call result');
      if (!delegation.settle(result)) {
        throw new HttpError(404, 'Unknown or finished model call');
      }
      return { ok: true };
    }
    case 'POST /model-calls/text': {
      const text = await readRequest(request, parseDelegatedText, 'model call text');
      if (!delegation.text(text.id, text.text)) {
        throw new HttpError(404, 'Unknown or finished model call');
      }
      return { ok: true };
    }
    default:
      throw new HttpError(404, 'Not found');
  }
};

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
    case 'POST /architecture/discuss':
      return await service.discuss(await readRequest(request, parseDiscussion, 'architecture discussion'));
    case 'POST /standards/scan':
      log('standards scan started');
      return await service.scanStandards();
    case 'POST /standards/investigate':
      return await investigate(service, request);
    default:
      throw new HttpError(404, 'Not found');
  }
};

const HEARTBEAT_MS = 15_000;
const streamScan = async (service: ReviewService, response: ServerResponse): Promise<void> => {
  response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const send = (event: unknown): void => {
    if (!response.destroyed) { response.write(`${JSON.stringify(event)}\n`); }
  };
  const heartbeat = setInterval(() => { if (!response.destroyed) { response.write('\n'); } }, HEARTBEAT_MS);
  heartbeat.unref();
  response.on('close', () => { clearInterval(heartbeat); });
  try { send({ result: await service.scanStandards((progress) => { send({ progress }); }) }); }
  catch (error: unknown) { send({ error: publicMessage(error) }); }
  finally { clearInterval(heartbeat); response.end(); }
};
/** A viewer that stops reading is dropped rather than letting unsent events pile up in memory. */
const MAX_UNSENT_BYTES = 8_000_000;

/** GET /events: newline-delimited JSON, the recent backlog first, then live events and a periodic heartbeat. */
const streamConversations = (conversations: ConversationLog, request: IncomingMessage, response: ServerResponse): void => {
  response.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const send = (line: string): void => {
    if (response.writableLength > MAX_UNSENT_BYTES) {
      response.destroy();
      return;
    }
    response.write(`${line}\n`);
  };
  for (const event of conversations.recent()) {
    send(JSON.stringify(event));
  }
  const unsubscribe = conversations.subscribe((event) => {
    send(JSON.stringify(event));
  });
  const heartbeat = setInterval(() => {
    send('');
  }, HEARTBEAT_MS);
  // The heartbeat must never keep a reviewer process alive on its own after shutdown.
  heartbeat.unref();
  request.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
};

/**
 * Stops accepting requests and closes every open connection, including live-log streams. `close` alone waits for
 * those long-lived responses to end, which would keep a stopped reviewer serving its old log indefinitely.
 */
export const shutdownReviewerServer = (server: Server): void => {
  server.close();
  server.closeAllConnections();
};

/** Delegated-call routes and review routes are kept apart; both sit behind the same token check. */
const dispatch = async (service: ReviewService, delegation: Delegation, request: IncomingMessage): Promise<unknown> => {
  const path = request.url ?? '';
  return path === '/model-calls' || path.startsWith('/model-calls/')
    ? await delegationRoute(delegation, `${request.method ?? ''} ${path}`, request)
    : await route(service, request);
};

export const createReviewerServer = (service: ReviewService, token: string, conversations = new ConversationLog(), delegation = new Delegation()): Server =>
  createServer((request, response) => {
    if (!isAuthorized(request, token)) {
      sendJson(response, 401, { error: 'Unauthorized' });
      return;
    }
    if (request.method === 'GET' && request.url === '/events') {
      streamConversations(conversations, request, response);
      return;
    }
    if (request.method === 'POST' && request.url === '/standards/scan' && request.headers.accept === 'application/x-ndjson') {
      void streamScan(service, response);
      return;
    }
    dispatch(service, delegation, request).then(
      (body) => {
        sendJson(response, 200, body);
      },
      (error: unknown) => {
        const status = error instanceof HttpError ? error.status : (error instanceof UnknownRuleError ? 409 : 500);
        const message = publicMessage(error);
        log(`error ${String(status)}: ${message}`);
        sendJson(response, status, { error: message });
      },
    );
  });
