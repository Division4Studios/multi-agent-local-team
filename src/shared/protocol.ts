/**
 * Wire protocol between the MALT extension and the reviewer service.
 * Everything crossing the boundary is validated with the parsers below; nothing is trusted by shape.
 */
import { isNonNegativeInteger, isRecord, isString, parseArray, readStrings } from './guards';

export const PROTOCOL_VERSION = 2;
export const STANDARDS_FILE = '.malt/standards.json';
export const ARCHITECTURE_FILE = '.malt/architecture.json';

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

/** One entry of the architecture map: an existing source file, what it is for, and what it exports. */
export interface ArchitectureModule {
  readonly path: string;
  readonly purpose: string;
  readonly exports: readonly string[];
}

export interface ArchitectureDocument {
  readonly version: 1;
  readonly generatedAt: string;
  readonly modules: readonly ArchitectureModule[];
}

/** POST /consolidation: every changed block, so new code can be compared across the whole change. */
export interface ConsolidationRequest {
  readonly blocks: readonly ReviewRequest[];
}

/** Rules the scan inferred from the code (not from a document) carry this source prefix, set by MALT. */
export const INFERRED_SOURCE_PREFIX = 'Inferred from code: ';

/**
 * Something a person should look at, with the files involved: new code that overlaps with other code
 * (consolidation), or a gap in the project's standards (scan).
 */
export interface Finding {
  readonly title: string;
  readonly files: readonly string[];
  readonly note: string;
  readonly detail: string;
  /**
   * Where in each file the finding applies: a declaration name, located by MALT in the real file. Never line
   * numbers from the model, so a highlight always points at code that exists. Older files have none.
   */
  readonly anchors: readonly FindingAnchor[];
}

export interface FindingAnchor {
  readonly file: string;
  readonly symbol: string;
}

export interface StandardsDocument {
  readonly version: 1;
  readonly generatedAt: string;
  /** Rules from the project's documents, then rules inferred from the code. */
  readonly rules: readonly Rule[];
  /** Missing or contradictory standards the scan could not turn into rules; for a person to decide. */
  readonly gaps: readonly Finding[];
}

/** Answer to POST /standards/scan: documented and inferred rules, gaps, and the architecture map. */
export interface StandardsScan {
  readonly rules: readonly Rule[];
  readonly gaps: readonly Finding[];
  readonly sources: readonly string[];
  readonly modules: readonly ArchitectureModule[];
  /** Parts of the scan that failed (mapping, gap analysis) while the rest succeeded. */
  readonly warnings: readonly string[];
}

export interface HealthResponse {
  readonly ok: boolean;
  readonly protocolVersion: number;
  readonly provider: string;
  readonly rulesLoaded: number;
  readonly gapsFound: number;
  readonly modulesLoaded: number;
  /** When the architecture map was generated; empty if there is none. */
  readonly architectureScannedAt: string;
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

const parseString = (value: unknown): string | undefined => (isString(value) ? value : undefined);

export const parseArchitectureModule = (value: unknown): ArchitectureModule | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const strings = readStrings(value, ['path', 'purpose']);
  const names = parseArray(value['exports'], parseString);
  return strings === undefined || names === undefined ? undefined : { ...strings, exports: names };
};

export const parseModules = (value: unknown): ArchitectureModule[] | undefined => parseArray(value, parseArchitectureModule);

const parseAnchor = (value: unknown): FindingAnchor | undefined =>
  isRecord(value) ? readStrings(value, ['file', 'symbol']) : undefined;

export const parseFinding = (value: unknown): Finding | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const strings = readStrings(value, ['title', 'note', 'detail']);
  const files = parseArray(value['files'], parseString);
  // Findings saved before anchors existed have none.
  const anchors = value['anchors'] === undefined ? [] : parseArray(value['anchors'], parseAnchor);
  return strings === undefined || files === undefined || anchors === undefined ? undefined : { ...strings, files, anchors };
};

export const parseRuleCheck = (value: unknown): RuleCheck | undefined => {
  if (!isRecord(value) || !isCheckStatus(value['status'])) {
    return undefined;
  }
  const strings = readStrings(value, ['ruleId', 'title', 'note', 'detail']);
  return strings === undefined ? undefined : { ...strings, status: value['status'] };
};


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

export const parseConsolidationRequest = (value: unknown): ConsolidationRequest | undefined => {
  const blocks = isRecord(value) ? parseArray(value['blocks'], parseReviewRequest) : undefined;
  return blocks === undefined ? undefined : { blocks };
};

export const parseArchitectureDocument = (value: unknown): ArchitectureDocument | undefined => {
  if (!isRecord(value) || value['version'] !== 1 || !isString(value['generatedAt'])) {
    return undefined;
  }
  const modules = parseModules(value['modules']);
  return modules === undefined ? undefined : { version: 1, generatedAt: value['generatedAt'], modules };
};

export const parseStandardsDocument = (value: unknown): StandardsDocument | undefined => {
  if (!isRecord(value) || value['version'] !== 1 || !isString(value['generatedAt'])) {
    return undefined;
  }
  const rules = parseRules(value['rules']);
  // Files written before gap analysis existed have no gaps.
  const gaps = value['gaps'] === undefined ? [] : parseArray(value['gaps'], parseFinding);
  return rules === undefined || gaps === undefined ? undefined : { version: 1, generatedAt: value['generatedAt'], rules, gaps };
};

export const parseStandardsScan = (value: unknown): StandardsScan | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const rules = parseRules(value['rules']);
  const gaps = parseArray(value['gaps'], parseFinding);
  const sources = parseArray(value['sources'], parseString);
  const modules = parseModules(value['modules']);
  const warnings = parseArray(value['warnings'], parseString);
  if (rules === undefined || gaps === undefined || sources === undefined || modules === undefined || warnings === undefined) {
    return undefined;
  }
  return { rules, gaps, sources, modules, warnings };
};

export const parseHealthResponse = (value: unknown): HealthResponse | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { ok, protocolVersion, provider, rulesLoaded, gapsFound, modulesLoaded, architectureScannedAt } = value;
  if (typeof ok !== 'boolean' || !isNonNegativeInteger(protocolVersion) || !isString(provider) || !isString(architectureScannedAt)) {
    return undefined;
  }
  return isNonNegativeInteger(rulesLoaded) && isNonNegativeInteger(gapsFound) && isNonNegativeInteger(modulesLoaded)
    ? { ok, protocolVersion, provider, rulesLoaded, gapsFound, modulesLoaded, architectureScannedAt }
    : undefined;
};
