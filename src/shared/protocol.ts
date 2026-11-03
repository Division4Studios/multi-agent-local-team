/**
 * Wire protocol between the MALT extension and the reviewer service.
 * Everything crossing the boundary is validated with the parsers below; nothing is trusted by shape.
 */
import { isNonNegativeInteger, isRecord, isString, parseArray, readStrings } from './guards';

export const PROTOCOL_VERSION = 2;
export const STANDARDS_FILE = '.malt/standards.json';

export type CheckStatus = 'pass' | 'fail' | 'not-applicable';

/** A short, checkable project standard extracted from docs, skills and configs. `category` is its group. */
export interface Rule {
  readonly id: string;
  readonly title: string;
  readonly check: string;
  readonly category: string;
  readonly source: string;
}

/** The result of reviewing one block against one rule, in its own isolated call. */
export interface RuleCheck {
  readonly ruleId: string;
  readonly title: string;
  readonly status: CheckStatus;
  /** One sentence for the tree and hover. */
  readonly note: string;
  /** The full explanation, shown on the rule's detail page. */
  readonly detail: string;
}

/** The reviewer's description of one changed block, and the ids of the rules that could concern it. */
export interface BlockOverview {
  readonly summary: string;
  readonly purpose: string;
  readonly technical: string;
  readonly design: string;
  readonly applicable: readonly string[];
}

/** Answer to POST /review: the overview plus the rules it was sorted against (baseline first). */
export interface OverviewResponse {
  readonly overview: BlockOverview;
  readonly rules: readonly Rule[];
}

/** A block's review as the extension keeps it; `checks` fill in one rule at a time. */
export interface HunkReview extends OverviewResponse {
  readonly checks: readonly RuleCheck[];
}

export interface ReviewRequest {
  /** Workspace-relative path with forward slashes. */
  readonly filePath: string;
  /** Zero-based, inclusive line range of the changed block in the current file. */
  readonly startLine: number;
  readonly endLine: number;
  /** Unified-diff text of the block (header and body). */
  readonly patch: string;
}

/** POST /check: one block against one rule, named by id; the reviewer looks the rule up itself. */
export interface CheckRequest extends ReviewRequest {
  readonly ruleId: string;
}

export interface StandardsDocument {
  readonly version: 1;
  readonly generatedAt: string;
  readonly rules: readonly Rule[];
}

export interface HealthResponse {
  readonly ok: boolean;
  readonly protocolVersion: number;
  readonly provider: string;
  readonly rulesLoaded: number;
}

const CHECK_STATUSES: readonly string[] = ['pass', 'fail', 'not-applicable'];

const isCheckStatus = (value: unknown): value is CheckStatus => isString(value) && CHECK_STATUSES.includes(value);

export const parseRule = (value: unknown): Rule | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  return readStrings(value, ['id', 'title', 'check', 'category', 'source']);
};

export const parseRules = (value: unknown): Rule[] | undefined => parseArray(value, parseRule);

export const parseRuleCheck = (value: unknown): RuleCheck | undefined => {
  if (!isRecord(value) || !isCheckStatus(value['status'])) {
    return undefined;
  }
  const strings = readStrings(value, ['ruleId', 'title', 'note', 'detail']);
  return strings === undefined ? undefined : { ...strings, status: value['status'] };
};

const parseString = (value: unknown): string | undefined => (isString(value) ? value : undefined);

export const parseBlockOverview = (value: unknown): BlockOverview | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const strings = readStrings(value, ['summary', 'purpose', 'technical', 'design']);
  const applicable = parseArray(value['applicable'], parseString);
  return strings === undefined || applicable === undefined ? undefined : { ...strings, applicable };
};

export const parseOverviewResponse = (value: unknown): OverviewResponse | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const overview = parseBlockOverview(value['overview']);
  const rules = parseRules(value['rules']);
  return overview === undefined || rules === undefined ? undefined : { overview, rules };
};

export const parseHunkReview = (value: unknown): HunkReview | undefined => {
  const response = parseOverviewResponse(value);
  const checks = isRecord(value) ? parseArray(value['checks'], parseRuleCheck) : undefined;
  return response === undefined || checks === undefined ? undefined : { ...response, checks };
};

export const parseReviewRequest = (value: unknown): ReviewRequest | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { startLine, endLine } = value;
  const strings = readStrings(value, ['filePath', 'patch']);
  if (strings === undefined || !isNonNegativeInteger(startLine) || !isNonNegativeInteger(endLine)) {
    return undefined;
  }
  return endLine < startLine ? undefined : { ...strings, startLine, endLine };
};

export const parseCheckRequest = (value: unknown): CheckRequest | undefined => {
  const request = parseReviewRequest(value);
  const ruleId = isRecord(value) ? value['ruleId'] : undefined;
  return request === undefined || !isString(ruleId) ? undefined : { ...request, ruleId };
};

export const parseStandardsDocument = (value: unknown): StandardsDocument | undefined => {
  if (!isRecord(value) || value['version'] !== 1 || !isString(value['generatedAt'])) {
    return undefined;
  }
  const rules = parseRules(value['rules']);
  return rules === undefined ? undefined : { version: 1, generatedAt: value['generatedAt'], rules };
};

export const parseHealthResponse = (value: unknown): HealthResponse | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { ok, protocolVersion, provider, rulesLoaded } = value;
  if (typeof ok !== 'boolean' || !isNonNegativeInteger(protocolVersion) || !isString(provider)) {
    return undefined;
  }
  return isNonNegativeInteger(rulesLoaded) ? { ok, protocolVersion, provider, rulesLoaded } : undefined;
};
