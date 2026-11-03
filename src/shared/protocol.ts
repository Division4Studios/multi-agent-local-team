/**
 * Wire protocol between the MALT extension and the reviewer service.
 * Everything crossing the boundary is validated with the parsers below; nothing is trusted by shape.
 */
import { isNonNegativeInteger, isRecord, isString, parseArray, readStrings } from './guards';

export const PROTOCOL_VERSION = 1;
export const STANDARDS_FILE = '.malt/standards.json';

export type Verdict = 'pass' | 'concerns' | 'fail';
export type CheckStatus = 'pass' | 'fail' | 'not-applicable';

/** A short, checkable project standard extracted from docs, skills and configs. */
export interface Rule {
  readonly id: string;
  readonly title: string;
  readonly check: string;
  readonly category: string;
  readonly source: string;
}

export interface RuleCheck {
  readonly ruleId: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly note: string;
}

/** The reviewer's answer for one changed block. */
export interface HunkReview {
  readonly verdict: Verdict;
  readonly summary: string;
  readonly what: string;
  readonly why: string;
  readonly necessity: string;
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

const VERDICTS: readonly string[] = ['pass', 'concerns', 'fail'];
const CHECK_STATUSES: readonly string[] = ['pass', 'fail', 'not-applicable'];

const isVerdict = (value: unknown): value is Verdict => isString(value) && VERDICTS.includes(value);
const isCheckStatus = (value: unknown): value is CheckStatus => isString(value) && CHECK_STATUSES.includes(value);

export const parseRule = (value: unknown): Rule | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  return readStrings(value, ['id', 'title', 'check', 'category', 'source']);
};

export const parseRuleCheck = (value: unknown): RuleCheck | undefined => {
  if (!isRecord(value) || !isCheckStatus(value['status'])) {
    return undefined;
  }
  const strings = readStrings(value, ['ruleId', 'title', 'note']);
  return strings === undefined ? undefined : { ...strings, status: value['status'] };
};

export const parseHunkReview = (value: unknown): HunkReview | undefined => {
  if (!isRecord(value) || !isVerdict(value['verdict'])) {
    return undefined;
  }
  const strings = readStrings(value, ['summary', 'what', 'why', 'necessity']);
  const checks = parseArray(value['checks'], parseRuleCheck);
  if (strings === undefined || checks === undefined) {
    return undefined;
  }
  return { ...strings, verdict: value['verdict'], checks };
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

export const parseRules = (value: unknown): Rule[] | undefined => parseArray(value, parseRule);

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
