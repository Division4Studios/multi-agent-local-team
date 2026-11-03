/** Review and standards-scan operations, independent of HTTP. */
import { parseBlockOverview, parseRuleCheck, parseRules } from '../shared/protocol';
import { isRecord } from '../shared/guards';
import type { CheckRequest, OverviewResponse, ReviewRequest, Rule, RuleCheck } from '../shared/protocol';
import type { ReviewProvider } from './providers/provider';
import {
  BASELINE_RULES,
  CHECK_SCHEMA,
  CHECK_SYSTEM_PROMPT,
  OVERVIEW_SCHEMA,
  OVERVIEW_SYSTEM_PROMPT,
  RULES_SCHEMA,
  STANDARDS_SYSTEM_PROMPT,
  buildCheckUserPrompt,
  buildOverviewUserPrompt,
  buildStandardsUserPrompt,
} from './prompts';
import { collectStandardsSources } from './standardsSources';
import { createNonce, enforceCheckPolicy, enforceOverviewPolicy, sanitizeProjectRules } from './trust';
import { loadRules, readFileWindow } from './workspace';

const REVIEW_TIMEOUT_MS = 180_000;
const SCAN_TIMEOUT_MS = 900_000;

export interface ServiceConfig {
  readonly workspaceRoot: string;
  /** Writes each block's overview and sorts out which rules apply to it. */
  readonly triageModel: string;
  /** Checks one block against one rule. */
  readonly reviewModel: string;
  readonly standardsModel: string;
}

export class ReviewService {
  private readonly config: ServiceConfig;
  private readonly provider: ReviewProvider;

  public constructor(config: ServiceConfig, provider: ReviewProvider) {
    this.config = config;
    this.provider = provider;
  }

  public get providerName(): string {
    return this.provider.name;
  }

  /** Project rules from `.malt/standards.json`, sanitized; never shadow or replace the baseline rules. */
  public async rules(): Promise<readonly Rule[]> {
    return sanitizeProjectRules(await loadRules(this.config.workspaceRoot), BASELINE_RULES);
  }

  /** One call per block: the human-readable overview, and which rules are worth a separate check. */
  public async review(request: ReviewRequest): Promise<OverviewResponse> {
    const [projectRules, window] = await Promise.all([
      this.rules(),
      readFileWindow(this.config.workspaceRoot, request.filePath, request),
    ]);
    const output = await this.provider.callStructured({
      systemPrompt: OVERVIEW_SYSTEM_PROMPT,
      userPrompt: buildOverviewUserPrompt(request, window, projectRules, createNonce()),
      schema: OVERVIEW_SCHEMA,
      model: this.config.triageModel,
      timeoutMs: REVIEW_TIMEOUT_MS,
    });
    const overview = parseBlockOverview(output);
    if (overview === undefined) {
      throw new Error('Provider returned an overview that does not match the protocol');
    }
    const rules = [...BASELINE_RULES, ...projectRules];
    return { overview: enforceOverviewPolicy(overview, rules), rules };
  }

  /** One isolated call per rule. The rule is looked up here, so the caller can only name it, not define it. */
  public async check(request: CheckRequest): Promise<RuleCheck> {
    const [projectRules, window] = await Promise.all([
      this.rules(),
      readFileWindow(this.config.workspaceRoot, request.filePath, request),
    ]);
    const rule = [...BASELINE_RULES, ...projectRules].find((candidate) => candidate.id === request.ruleId);
    if (rule === undefined) {
      throw new Error(`Unknown rule: ${request.ruleId}`);
    }
    const output = await this.provider.callStructured({
      systemPrompt: CHECK_SYSTEM_PROMPT,
      userPrompt: buildCheckUserPrompt(request, window, rule, { projectRules, nonce: createNonce() }),
      schema: CHECK_SCHEMA,
      model: this.config.reviewModel,
      timeoutMs: REVIEW_TIMEOUT_MS,
    });
    const check = isRecord(output) ? parseRuleCheck({ ...output, ruleId: rule.id, title: rule.title }) : undefined;
    if (check === undefined) {
      throw new Error('Provider returned a check that does not match the protocol');
    }
    return enforceCheckPolicy(check, rule);
  }

  public async scanStandards(): Promise<{ readonly rules: readonly Rule[]; readonly sources: readonly string[] }> {
    const sources = await collectStandardsSources(this.config.workspaceRoot);
    if (sources.length === 0) {
      return { rules: [], sources: [] };
    }
    const output = await this.provider.callStructured({
      systemPrompt: STANDARDS_SYSTEM_PROMPT,
      userPrompt: buildStandardsUserPrompt(sources, createNonce()),
      schema: RULES_SCHEMA,
      model: this.config.standardsModel,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
    const rules = isRecord(output) ? parseRules(output['rules']) : undefined;
    if (rules === undefined) {
      throw new Error('Provider returned rules that do not match the protocol');
    }
    return { rules: sanitizeProjectRules(rules, BASELINE_RULES), sources: sources.map((source) => source.path) };
  }
}
