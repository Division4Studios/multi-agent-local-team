/** Review and standards-scan operations, independent of HTTP. */
import { parseArray, isRecord } from '../shared/guards';
import { INFERRED_SOURCE_PREFIX, parseBlockOverview, parseFinding, parseModules, parseRuleCheck, parseRules } from '../shared/protocol';
import type {
  ArchitectureDocument,
  ArchitectureModule,
  CheckRequest,
  Finding,
  ConsolidationRequest,
  OverviewResponse,
  ReviewRequest,
  Rule,
  RuleCheck,
  StandardsScan,
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
  GAPS_SCHEMA,
  GAPS_SYSTEM_PROMPT,
  OVERVIEW_SCHEMA,
  OVERVIEW_SYSTEM_PROMPT,
  RULES_SCHEMA,
  STANDARDS_SYSTEM_PROMPT,
  buildArchitectureUserPrompt,
  buildCheckUserPrompt,
  buildConsolidationUserPrompt,
  buildGapsUserPrompt,
  buildOverviewUserPrompt,
  buildStandardsUserPrompt,
} from './prompts';
import { collectCodeSources, collectStandardsSources } from './standardsSources';
import type { SourceFile } from './standardsSources';
import { describeError } from './log';
import { createNonce, enforceCheckPolicy, enforceFindingPolicy, enforceOverviewPolicy, sanitizeModules, sanitizeProjectRules } from './trust';
import { loadArchitecture, loadStandards, readFileWindow } from './workspace';

const REVIEW_TIMEOUT_MS = 180_000;
const SCAN_TIMEOUT_MS = 900_000;
/** How many map entries a block review, and a whole-change consolidation check, may include. */
const BLOCK_SLICE = 25;
const CHANGE_SLICE = 80;
const MAX_INFERRED_RULES = 15;

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
    return sanitizeProjectRules((await loadStandards(this.config.workspaceRoot))?.rules ?? [], BASELINE_RULES);
  }

  /** How many standards gaps the last scan recorded. */
  public async gapCount(): Promise<number> {
    return (await loadStandards(this.config.workspaceRoot))?.gaps.length ?? 0;
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

  /**
   * Standards scan: rules from the documents and the architecture map from the code (in parallel), then one call
   * comparing them for conventions the code follows that no document states (inferred rules) and for gaps. A failed
   * map or gap call is reported as a warning so the documented rules are still saved.
   */
  public async scanStandards(): Promise<StandardsScan> {
    const root = this.config.workspaceRoot;
    const [sources, code] = await Promise.all([collectStandardsSources(root), collectCodeSources(root)]);
    const [documented, mapped] = await Promise.allSettled([this.extractRules(sources), this.mapCode(code)]);
    if (documented.status === 'rejected') {
      throw new Error(describeError(documented.reason));
    }
    const documents = sources.map((source) => source.path);
    const scan: StandardsScan = { rules: documented.value, gaps: [], sources: documents, modules: [], warnings: [] };
    if (mapped.status === 'rejected') {
      return { ...scan, warnings: [`The code could not be mapped: ${describeError(mapped.reason)}`] };
    }
    if (mapped.value.length === 0) {
      return scan;
    }
    try {
      const { inferred, gaps } = await this.findGaps(documented.value, documents, mapped.value);
      return { ...scan, rules: [...documented.value, ...inferred], gaps, modules: mapped.value };
    } catch (error: unknown) {
      return { ...scan, modules: mapped.value, warnings: [`Gap analysis failed: ${describeError(error)}`] };
    }
  }

  private async extractRules(sources: readonly SourceFile[]): Promise<readonly Rule[]> {
    if (sources.length === 0) {
      return [];
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
    return sanitizeProjectRules(rules, BASELINE_RULES);
  }

  /** Maps each source file to a purpose and its exports; the extension saves the result as the architecture map. */
  private async mapCode(sources: readonly SourceFile[]): Promise<readonly ArchitectureModule[]> {
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

  /** Inferred rules never shadow baseline or documented ones, and MALT marks their source as inferred. */
  private async findGaps(
    documented: readonly Rule[],
    documents: readonly string[],
    modules: readonly ArchitectureModule[],
  ): Promise<{ readonly inferred: readonly Rule[]; readonly gaps: readonly Finding[] }> {
    const output = await this.provider.callStructured({
      systemPrompt: GAPS_SYSTEM_PROMPT,
      userPrompt: buildGapsUserPrompt(documented, documents, modules, createNonce()),
      schema: GAPS_SCHEMA,
      model: this.config.standardsModel,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
    const rules = isRecord(output) ? parseRules(output['rules']) : undefined;
    const gaps = isRecord(output) ? parseArray(output['gaps'], parseFinding) : undefined;
    if (rules === undefined || gaps === undefined) {
      throw new Error('Provider returned a gap analysis that does not match the protocol');
    }
    const inferred = sanitizeProjectRules(rules, [...BASELINE_RULES, ...documented])
      .slice(0, MAX_INFERRED_RULES)
      .map((rule) => ({ ...rule, source: `${INFERRED_SOURCE_PREFIX}${rule.source}` }));
    const known = new Set([...documents, ...modules.map((module) => module.path)]);
    return { inferred, gaps: enforceFindingPolicy(gaps, known, true) };
  }

  /** One call over the whole change. A change without new declarations needs no call. */
  public async consolidation(request: ConsolidationRequest): Promise<readonly Finding[]> {
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
    const findings = isRecord(output) ? parseArray(output['findings'], parseFinding) : undefined;
    if (findings === undefined) {
      throw new Error('Provider returned consolidation findings that do not match the protocol');
    }
    const known = new Set([...request.blocks.map((block) => block.filePath), ...architecture.map((module) => module.path)]);
    return enforceFindingPolicy(findings, known);
  }
}
