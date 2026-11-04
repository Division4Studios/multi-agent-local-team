/** Review and standards-scan operations, independent of HTTP. */
import { parseArray, isRecord } from '../shared/guards';
import { parseBlockOverview, parseConsolidationFinding, parseModules, parseRuleCheck, parseRules } from '../shared/protocol';
import type {
  ArchitectureDocument,
  ArchitectureModule,
  CheckRequest,
  ConsolidationFinding,
  ConsolidationRequest,
  OverviewResponse,
  ReviewRequest,
  Rule,
  RuleCheck,
} from '../shared/protocol';
import type { ReviewProvider } from './providers/provider';
import { architectureSlice, newDeclarations } from './architecture';
import {
  ARCHITECTURE_SCHEMA,
  ARCHITECTURE_SYSTEM_PROMPT,
  BASELINE_RULES,
  CHECK_SCHEMA,
  CHECK_SYSTEM_PROMPT,
  CONSOLIDATION_SCHEMA,
  CONSOLIDATION_SYSTEM_PROMPT,
  OVERVIEW_SCHEMA,
  OVERVIEW_SYSTEM_PROMPT,
  RULES_SCHEMA,
  STANDARDS_SYSTEM_PROMPT,
  buildArchitectureUserPrompt,
  buildCheckUserPrompt,
  buildConsolidationUserPrompt,
  buildOverviewUserPrompt,
  buildStandardsUserPrompt,
} from './prompts';
import { collectCodeSources, collectStandardsSources } from './standardsSources';
import { createNonce, enforceCheckPolicy, enforceConsolidationPolicy, enforceOverviewPolicy, sanitizeModules, sanitizeProjectRules } from './trust';
import { loadArchitecture, loadRules, readFileWindow } from './workspace';

const REVIEW_TIMEOUT_MS = 180_000;
const SCAN_TIMEOUT_MS = 900_000;
/** How many map entries a block review, and a whole-change consolidation check, may include. */
const BLOCK_SLICE = 25;
const CHANGE_SLICE = 80;

/** Rules in this group get the architecture map slice; other checks do not need it. */
const isArchitectureRule = (rule: Rule): boolean => rule.category.toLowerCase() === 'architecture';

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

  /** The architecture map, re-sanitized: it is a generated file in the repository, so it is untrusted. */
  public async architecture(): Promise<ArchitectureDocument> {
    const document = await loadArchitecture(this.config.workspaceRoot);
    return { ...document, modules: sanitizeModules(document.modules, new Set(document.modules.map((module) => module.path))) };
  }

  private async blockSlice(request: ReviewRequest): Promise<readonly ArchitectureModule[]> {
    return architectureSlice((await this.architecture()).modules, [request], BLOCK_SLICE);
  }

  /** One call per block: the human-readable overview, and which rules are worth a separate check. */
  public async review(request: ReviewRequest): Promise<OverviewResponse> {
    const [projectRules, window, architecture] = await Promise.all([
      this.rules(),
      readFileWindow(this.config.workspaceRoot, request.filePath, request),
      this.blockSlice(request),
    ]);
    const output = await this.provider.callStructured({
      systemPrompt: OVERVIEW_SYSTEM_PROMPT,
      userPrompt: buildOverviewUserPrompt(request, window, { projectRules, architecture, nonce: createNonce() }),
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
    const architecture = isArchitectureRule(rule) ? await this.blockSlice(request) : [];
    const output = await this.provider.callStructured({
      systemPrompt: CHECK_SYSTEM_PROMPT,
      userPrompt: buildCheckUserPrompt(request, window, rule, { projectRules, architecture, nonce: createNonce() }),
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

  /** Maps each source file to a purpose and its exports; the extension saves the result as the architecture map. */
  public async scanArchitecture(): Promise<readonly ArchitectureModule[]> {
    const sources = await collectCodeSources(this.config.workspaceRoot);
    if (sources.length === 0) {
      return [];
    }
    const output = await this.provider.callStructured({
      systemPrompt: ARCHITECTURE_SYSTEM_PROMPT,
      userPrompt: buildArchitectureUserPrompt(sources, createNonce()),
      schema: ARCHITECTURE_SCHEMA,
      model: this.config.standardsModel,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
    const modules = isRecord(output) ? parseModules(output['modules']) : undefined;
    if (modules === undefined) {
      throw new Error('Provider returned an architecture map that does not match the protocol');
    }
    return sanitizeModules(modules, new Set(sources.map((source) => source.path)));
  }

  /** One call over the whole change. A change without new declarations needs no call. */
  public async consolidation(request: ConsolidationRequest): Promise<readonly ConsolidationFinding[]> {
    const declarations = newDeclarations(request.blocks);
    if (declarations.length === 0) {
      return [];
    }
    const architecture = architectureSlice((await this.architecture()).modules, request.blocks, CHANGE_SLICE);
    const output = await this.provider.callStructured({
      systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
      userPrompt: buildConsolidationUserPrompt(declarations, architecture, createNonce()),
      schema: CONSOLIDATION_SCHEMA,
      model: this.config.reviewModel,
      timeoutMs: REVIEW_TIMEOUT_MS,
    });
    const findings = isRecord(output) ? parseArray(output['findings'], parseConsolidationFinding) : undefined;
    if (findings === undefined) {
      throw new Error('Provider returned consolidation findings that do not match the protocol');
    }
    const known = new Set([...request.blocks.map((block) => block.filePath), ...architecture.map((module) => module.path)]);
    return enforceConsolidationPolicy(findings, known);
  }
}
