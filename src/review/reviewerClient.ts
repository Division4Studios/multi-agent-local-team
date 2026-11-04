/** HTTP client for the reviewer service, bound to 127.0.0.1 and authenticated with a per-start token. */
import { request as httpRequest } from 'node:http';
import { isRecord, isString, parseArray } from '../shared/guards';
import { parseConversationEvent } from '../shared/conversation';
import type { ConversationEvent } from '../shared/conversation';
import { parseFinding, parseHealthResponse, parseOverviewResponse, parseRuleCheck, parseStandardsScan } from '../shared/protocol';
import type {
  CheckRequest,
  Finding,
  ConsolidationRequest,
  HealthResponse,
  OverviewResponse,
  ReviewRequest,
  RuleCheck,
  StandardsScan,
} from '../shared/protocol';

export interface ReviewerEndpoint {
  readonly port: number;
  readonly token: string;
}

const REVIEW_TIMEOUT_MS = 240_000;
/** Two scan calls run in parallel, then the gap analysis: up to two provider timeouts plus margin. */
const SCAN_TIMEOUT_MS = 1_860_000;

interface CallOptions {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
  readonly timeoutMs: number;
}

const call = async (endpoint: ReviewerEndpoint, options: CallOptions): Promise<unknown> =>
  await new Promise((resolvePromise, reject) => {
    const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: endpoint.port,
        method: options.method,
        path: options.path,
        timeout: options.timeoutMs,
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          'content-type': 'application/json',
          'content-length': payload?.length ?? 0,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            reject(new Error(`Reviewer returned invalid JSON (HTTP ${String(res.statusCode)})`));
            return;
          }
          if (res.statusCode === 200) {
            resolvePromise(parsed);
          } else {
            const message = isRecord(parsed) && isString(parsed['error']) ? parsed['error'] : 'unknown error';
            reject(new Error(`Reviewer error (HTTP ${String(res.statusCode)}): ${message}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Reviewer request timed out: ${options.path}`)));
    req.on('error', reject);
    req.end(payload);
  });

export class ReviewerClient {
  private readonly endpoint: ReviewerEndpoint;

  public constructor(endpoint: ReviewerEndpoint) {
    this.endpoint = endpoint;
  }

  public async health(): Promise<HealthResponse> {
    const health = parseHealthResponse(await call(this.endpoint, { method: 'GET', path: '/health', timeoutMs: 5_000 }));
    if (health === undefined) {
      throw new Error('Reviewer returned an invalid health response');
    }
    return health;
  }

  public async review(request: ReviewRequest): Promise<OverviewResponse> {
    const response = parseOverviewResponse(
      await call(this.endpoint, { method: 'POST', path: '/review', body: request, timeoutMs: REVIEW_TIMEOUT_MS }),
    );
    if (response === undefined) {
      throw new Error('Reviewer returned an invalid overview');
    }
    return response;
  }

  public async check(request: CheckRequest): Promise<RuleCheck> {
    const check = parseRuleCheck(
      await call(this.endpoint, { method: 'POST', path: '/check', body: request, timeoutMs: REVIEW_TIMEOUT_MS }),
    );
    if (check?.ruleId !== request.ruleId) {
      throw new Error('Reviewer returned an invalid check');
    }
    return check;
  }

  public async scanStandards(): Promise<StandardsScan> {
    const scan = parseStandardsScan(await call(this.endpoint, { method: 'POST', path: '/standards/scan', body: {}, timeoutMs: SCAN_TIMEOUT_MS }));
    if (scan === undefined) {
      throw new Error('Reviewer returned an invalid standards scan');
    }
    return scan;
  }

  public async consolidation(request: ConsolidationRequest): Promise<readonly Finding[]> {
    const result = await call(this.endpoint, { method: 'POST', path: '/consolidation', body: request, timeoutMs: REVIEW_TIMEOUT_MS });
    const findings = isRecord(result) ? parseArray(result['findings'], parseFinding) : undefined;
    if (findings === undefined) {
      throw new Error('Reviewer returned invalid consolidation findings');
    }
    return findings;
  }

  /**
   * Subscribes to the live conversation stream. Every line is validated; invalid lines are ignored. `onClose`
   * runs once when the stream ends for any reason. Returns a function that stops the subscription.
   */
  public streamConversations(onEvent: (event: ConversationEvent) => void, onClose: () => void): () => void {
    let closed = false;
    const close = (): void => {
      if (!closed) {
        closed = true;
        onClose();
      }
    };
    const req = httpRequest(
      { host: '127.0.0.1', port: this.endpoint.port, method: 'GET', path: '/events', headers: { authorization: `Bearer ${this.endpoint.token}` } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          close();
          return;
        }
        res.on('data', ndjsonReader(onEvent, () => req.destroy()));
        res.on('end', close);
        res.on('error', close);
      },
    );
    req.on('error', close);
    req.on('close', close);
    req.end();
    return () => {
      req.destroy();
    };
  }
}

const MAX_PENDING_CHARS = 2_000_000;

/** Splits a byte stream into validated conversation events; `abort` if a single line grows unreasonably long. */
const ndjsonReader = (onEvent: (event: ConversationEvent) => void, abort: () => void): ((chunk: Buffer) => void) => {
  let pending = '';
  return (chunk: Buffer): void => {
    const lines = (pending + chunk.toString('utf8')).split('\n');
    pending = lines.pop() ?? '';
    if (pending.length > MAX_PENDING_CHARS) {
      abort();
      return;
    }
    for (const line of lines.filter((text) => text.trim() !== '')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const event = parseConversationEvent(parsed);
      if (event !== undefined) {
        onEvent(event);
      }
    }
  };
};
