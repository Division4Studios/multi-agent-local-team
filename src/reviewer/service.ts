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
import type { ReviewProvider, StructuredCall } from './providers/provider';
import { ConversationLog } from './conversations';
import type { ReviewProfiles } from '../shared/reviewProfiles';
import type { CallUsage } from '../shared/conversation';
import { ground, groundModules, DISCUSSION_PROMPT } from './understanding';
import { interpretationSchema, parseInterpretation } from '../shared/understanding';
import type { DiscussionRequest, Interpretation } from '../shared/understanding';
import { dataBlock } from './trust';
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
import { collectCodeSources, collectStandardsSources, isSourceCodePath } from './standardsSources';
import type { SourceFile } from './standardsSources';
import { describeError } from './log';
import { redactSecrets } from './redact';
import { createNonce, enforceAnchors, enforceCheckPolicy, enforceFindingPolicy, enforceOverviewPolicy, sanitizeModules, sanitizeProjectRules } from './trust';
import { INVESTIGATION_SCHEMA, INVESTIGATION_SYSTEM_PROMPT, buildInvestigationUserPrompt, collectGapCode, enforceInvestigation } from './investigation';
import { gapId } from '../shared/investigation';
import type { GapInvestigation } from '../shared/investigation';
import { loadArchitecture, loadStandards, readFileWindow } from './workspace';
import type { ScanProgress, ScanStage } from '../shared/scanProgress';
import { needsComponentContext } from './reviewContext';
import { reviewWithEvidence } from './evidenceReview';

const scanStage = async <T>(stage: ScanStage, task: () => Promise<T>, report: (progress: ScanProgress) => void): Promise<T> => {
  report({ stage, state: 'running' });
  try {
    const result = await task();
    report({ stage, state: 'complete' });
    return result;
  } catch (error: unknown) {
    report({ stage, state: 'failed' });
    throw error;
  }
};

const REVIEW_TIMEOUT_MS = 180_000;
const SCAN_TIMEOUT_MS = 900_000;
/** How many map entries a block review, and a whole-change consolidation check, may include. */
const BLOCK_SLICE = 25;
const MAX_INFERRED_RULES = 15;

const blockLabel = (request: ReviewRequest): string =>
  `${request.filePath}:${String(request.startLine + 1)}${request.endLine === request.startLine ? '' : `-${String(request.endLine + 1)}`}`;

/** A check named a rule the current standards no longer contain (e.g. a rescan renamed it). The server answers 409. */
export class UnknownRuleError extends Error {}

export interface ServiceConfig {
  readonly workspaceRoot: string;
  /** Model and effort per kind of call: overview, rule check, consolidation, standards scan. */
  readonly profiles: ReviewProfiles;
  /** Public key that verifies the extension-signed branch map; without it, developer confirmations are ignored. */
  readonly mapVerifier?: string;
}

export class ReviewService {
  private readonly config: ServiceConfig;
  private readonly provider: ReviewProvider;
  private readonly conversations: ConversationLog;

  public constructor(config: ServiceConfig, provider: ReviewProvider, conversations = new ConversationLog()) {
    this.config = config;
    this.provider = provider;
    this.conversations = conversations;
  }

  /** Every model call goes through here, so the live log sees it start, stream and end, with its usage. */
  private async ask(label: string, call: StructuredCall): Promise<unknown> {
    const logged = this.conversations.begin(label, call, call.userPrompt);
    let usage: CallUsage | undefined;
    try {
      const output = await this.provider.callStructured({
        ...call,
        onText: logged.text,
        onUsage: (reported) => {
          usage = reported;
        },
      });
      logged.end(undefined, usage);
      return output;
    } catch (error: unknown) {
      logged.end(error, usage);
      throw error;
    }
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
    const document = await loadArchitecture(this.config.workspaceRoot, this.config.mapVerifier);
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
    const output = await this.ask(`Overview · ${blockLabel(request)}`, {
      systemPrompt: OVERVIEW_SYSTEM_PROMPT,
      userPrompt: buildOverviewUserPrompt(request, window, { projectRules, architecture, nonce: createNonce() }),
      schema: OVERVIEW_SCHEMA,
      ...this.config.profiles.overview,
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
      throw new UnknownRuleError(`Unknown rule: ${request.ruleId}`);
    }
    const { output } = await reviewWithEvidence({
      root: this.config.workspaceRoot, blocks: [request], startWithComponent: needsComponentContext(rule),
      loadModules: async () => (await this.architecture()).modules,
    }, async (scope) => await this.ask(`Check ${rule.id} · ${blockLabel(request)}${scope.requests.length === 0 ? '' : ` · evidence ${String(scope.requests.length)}`}`, {
      systemPrompt: CHECK_SYSTEM_PROMPT,
      userPrompt: buildCheckUserPrompt(request, window, rule, { projectRules, architecture: scope.architecture, nonce: createNonce(), component: scope.component, evidence: scope }),
      schema: CHECK_SCHEMA,
      ...this.config.profiles.check,
      timeoutMs: REVIEW_TIMEOUT_MS,
    }));
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
  public async scanStandards(report: (progress: ScanProgress) => void = () => undefined): Promise<StandardsScan> {
    const root = this.config.workspaceRoot;
    report({ stage: 'sources', state: 'running' });
    const [sources, code] = await Promise.all([collectStandardsSources(root), collectCodeSources(root)]);
    report({ stage: 'sources', state: 'complete' });
    const [documented, mapped] = await Promise.allSettled([
      scanStage('standards', async () => await this.extractRules(sources), report),
      scanStage('architecture', async () => await this.mapCode(code,sources), report),
    ]);
    if (documented.status === 'rejected') {
      throw new Error(describeError(documented.reason));
    }
    const documents = sources.map((source) => source.path);
    const scan: StandardsScan = { rules: documented.value, gaps: [], sources: documents, modules: [], warnings: [] };
    if (mapped.status === 'rejected') {
      report({ stage: 'gaps', state: 'skipped' });
      return { ...scan, warnings: [`The code could not be mapped: ${describeError(mapped.reason)}`] };
    }
    if (mapped.value.length === 0) {
      report({ stage: 'gaps', state: 'skipped' });
      return scan;
    }
    try {
      const { inferred, gaps } = await scanStage('gaps', async () => await this.findGaps(documented.value, documents, mapped.value), report);
      return { ...scan, rules: [...documented.value, ...inferred], gaps, modules: mapped.value };
    } catch (error: unknown) {
      return { ...scan, modules: mapped.value, warnings: [`Gap analysis failed: ${describeError(error)}`] };
    }
  }

  /**
   * Every field is redacted before the model sees it: the excerpt is raw source, and the developer may paste a
   * credential into the dialogue. Evidence is grounded in the redacted excerpt, the text the model actually saw.
   */
  public async discuss(request: DiscussionRequest): Promise<Interpretation> {
    const redacted: DiscussionRequest = {
      path: request.path, source: redactSecrets(request.source), context: redactSecrets(request.context), dialogue: redactSecrets(request.dialogue),
    };
    const output = await this.ask('Architecture discussion', {
      systemPrompt: DISCUSSION_PROMPT,
      userPrompt: dataBlock(createNonce(), 'architecture discussion (untrusted json)', JSON.stringify(redacted)),
      schema: interpretationSchema, ...this.config.profiles.investigation, timeoutMs: REVIEW_TIMEOUT_MS,
    });
    const answer = parseInterpretation(output);
    if (answer === undefined) {
      throw new Error('Invalid architecture discussion response');
    }
    return ground(answer, redacted.source);
  }

  private async extractRules(sources: readonly SourceFile[]): Promise<readonly Rule[]> {
    if (sources.length === 0) {
      return [];
    }
    const output = await this.ask(`Standards scan · ${String(sources.length)} document(s)`, {
      systemPrompt: STANDARDS_SYSTEM_PROMPT,
      userPrompt: buildStandardsUserPrompt(sources, createNonce()),
      schema: RULES_SCHEMA,
      ...this.config.profiles.standards,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
    const rules = isRecord(output) ? parseRules(output['rules']) : undefined;
    if (rules === undefined) {
      throw new Error('Provider returned rules that do not match the protocol');
    }
    return sanitizeProjectRules(rules, BASELINE_RULES);
  }

  /** Maps each source file to a purpose and its exports; the extension saves the result as the architecture map. */
  private async mapCode(sources: readonly SourceFile[], guidance: readonly SourceFile[]): Promise<readonly ArchitectureModule[]> {
    if (sources.length === 0) {
      return [];
    }
    const output = await this.ask(`Architecture map · ${String(sources.length)} source file(s)`, {
      systemPrompt: ARCHITECTURE_SYSTEM_PROMPT,
      userPrompt: buildArchitectureUserPrompt(sources, createNonce(), guidance),
      schema: ARCHITECTURE_SCHEMA,
      ...this.config.profiles.standards,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
    const modules = isRecord(output) ? parseModules(output['modules']) : undefined;
    if (modules === undefined) {
      throw new Error('Provider returned an architecture map that does not match the protocol');
    }
    return groundModules(sanitizeModules(modules, new Set(sources.map((source) => source.path))), sources);
  }

  /** Inferred rules never shadow baseline or documented ones, and MALT marks their source as inferred. */
  private async findGaps(
    documented: readonly Rule[],
    documents: readonly string[],
    modules: readonly ArchitectureModule[],
  ): Promise<{ readonly inferred: readonly Rule[]; readonly gaps: readonly Finding[] }> {
    const output = await this.ask('Gap analysis', {
      systemPrompt: GAPS_SYSTEM_PROMPT,
      userPrompt: buildGapsUserPrompt(documented, documents, modules, createNonce()),
      schema: GAPS_SCHEMA,
      ...this.config.profiles.standards,
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

  /**
   * A deeper review of one gap the last scan recorded. The gap is looked up here by id, so a caller can only name a
   * gap from `.malt/standards.json`, never supply one. Its anchors are re-checked like any finding.
   */
  public async investigateGap(id: string): Promise<GapInvestigation> {
    const root = this.config.workspaceRoot;
    const recorded = (await loadStandards(root))?.gaps.find((gap) => gapId(gap) === id);
    if (recorded === undefined) {
      throw new Error('Unknown gap: run Scan Project Standards again');
    }
    // `standards.json` is a file in the repository, so a gap's file list is untrusted: it may only name source files
    // the scan mapped. Anything else (an edited list naming `.env`, keys or notes) is dropped before reading.
    const { modules } = await this.architecture();
    const mapped = new Set(modules.map((module) => module.path).filter(isSourceCodePath));
    const files = recorded.files.filter((file) => mapped.has(file));
    const gap = { ...recorded, files, anchors: enforceAnchors(recorded.anchors, new Set(files)) };
    const code = files.length === 0 ? [] : await collectGapCode(root, gap, modules);
    if (code.length === 0) {
      throw new Error('This gap names no mapped source files to investigate. Run Scan Project Standards to refresh the map.');
    }
    const output = await this.ask(`Gap investigation · ${gap.title}`, {
      systemPrompt: INVESTIGATION_SYSTEM_PROMPT,
      userPrompt: buildInvestigationUserPrompt(gap, code, createNonce()),
      schema: INVESTIGATION_SCHEMA,
      ...this.config.profiles.investigation,
      timeoutMs: SCAN_TIMEOUT_MS,
    });
    const investigation = enforceInvestigation(output, { gapId: id, files: code });
    if (investigation === undefined) {
      throw new Error('Provider returned an investigation that does not match the protocol');
    }
    return investigation;
  }

  /**
   * One call over the whole change. A change without new declarations in source files needs no call: a declaration in
   * a documentation example has no implementation to supply, so no finding about it could be kept.
   */
  public async consolidation(request: ConsolidationRequest): Promise<readonly Finding[]> {
    const declarations = newDeclarations(request.blocks.filter((block) => isSourceCodePath(block.filePath)));
    if (declarations.length === 0) {
      return [];
    }
    const changed = new Set(declarations.map((file) => file.filePath));
    const projectRules = await this.rules();
    const { output, scope } = await reviewWithEvidence({
      root: this.config.workspaceRoot, blocks: request.blocks.filter((block) => changed.has(block.filePath)), startWithComponent: true,
      loadModules: async () => (await this.architecture()).modules,
    }, async (evidence) => {
      if (evidence.component === undefined) { throw new Error('Consolidation needs complete component evidence'); }
      return await this.ask(`Consolidation · ${String(request.blocks.length)} block(s)${evidence.requests.length === 0 ? '' : ` · evidence ${String(evidence.requests.length)}`}`, {
        systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
        userPrompt: buildConsolidationUserPrompt(declarations, evidence.architecture, createNonce(), { component: evidence.component, projectRules, evidence }),
        schema: CONSOLIDATION_SCHEMA,
        ...this.config.profiles.consolidation,
        timeoutMs: REVIEW_TIMEOUT_MS,
      });
    });
    const findings = isRecord(output) ? parseArray(output['findings'], parseFinding) : undefined;
    if (findings === undefined) {
      throw new Error('Provider returned consolidation findings that do not match the protocol');
    }
    const known = new Set(scope.component?.files.map((file) => file.path) ?? []);
    return enforceFindingPolicy(findings, known);
  }
}
