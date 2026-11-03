/** HTTP client for the reviewer service, bound to 127.0.0.1 and authenticated with a per-start token. */
import { request as httpRequest } from 'node:http';
import { isRecord, isString } from '../shared/guards';
import { parseHealthResponse, parseOverviewResponse, parseRuleCheck, parseRules } from '../shared/protocol';
import type { CheckRequest, HealthResponse, OverviewResponse, ReviewRequest, Rule, RuleCheck } from '../shared/protocol';

export interface ReviewerEndpoint {
  readonly port: number;
  readonly token: string;
}

const REVIEW_TIMEOUT_MS = 240_000;

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

  public async scanStandards(): Promise<{ readonly rules: readonly Rule[]; readonly sources: readonly string[] }> {
    const result = await call(this.endpoint, { method: 'POST', path: '/standards/scan', body: {}, timeoutMs: 960_000 });
    const rules = isRecord(result) ? parseRules(result['rules']) : undefined;
    const sources = isRecord(result) && Array.isArray(result['sources']) ? result['sources'].filter(isString) : undefined;
    if (rules === undefined || sources === undefined) {
      throw new Error('Reviewer returned an invalid standards scan');
    }
    return { rules, sources };
  }
}
