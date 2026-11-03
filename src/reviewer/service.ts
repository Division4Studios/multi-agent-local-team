/** Review and standards-scan operations, independent of HTTP. */
import { parseHunkReview, parseRules } from '../shared/protocol';
import { isRecord } from '../shared/guards';
import type { HunkReview, ReviewRequest, Rule } from '../shared/protocol';
import type { ReviewProvider } from './providers/provider';
import {
  BASELINE_RULES,
  HUNK_REVIEW_SCHEMA,
  REVIEW_SYSTEM_PROMPT,
  RULES_SCHEMA,
  STANDARDS_SYSTEM_PROMPT,
  buildReviewUserPrompt,
  buildStandardsUserPrompt,
} from './prompts';
import { collectStandardsSources } from './standardsSources';
import { createNonce, enforceReviewPolicy, sanitizeProjectRules } from './trust';
import { loadRules, readFileWindow } from './workspace';

const REVIEW_TIMEOUT_MS = 180_000;
const SCAN_TIMEOUT_MS = 900_000;

export interface ServiceConfig {
  readonly workspaceRoot: string;
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

  public async review(request: ReviewRequest): Promise<HunkReview> {
    const [projectRules, window] = await Promise.all([
      this.rules(),
      readFileWindow(this.config.workspaceRoot, request.filePath, request),
    ]);
    const output = await this.provider.callStructured({
      systemPrompt: REVIEW_SYSTEM_PROMPT,
      userPrompt: buildReviewUserPrompt(request, window, projectRules, createNonce()),
      schema: HUNK_REVIEW_SCHEMA,
      model: this.config.reviewModel,
      timeoutMs: REVIEW_TIMEOUT_MS,
    });
    const review = parseHunkReview(output);
    if (review === undefined) {
      throw new Error('Provider returned a review that does not match the protocol');
    }
    return enforceReviewPolicy(review, [...BASELINE_RULES, ...projectRules]);
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
