/** Tool-less model calls can ask MALT for bounded, confined evidence before returning a verdict. */
import { isRecord, parseArray } from '../shared/guards';
import type { ArchitectureModule, ReviewRequest } from '../shared/protocol';
import { collectComponentContext } from './reviewContext';
import type { ComponentContext } from './reviewContext';
import { reviewInventory } from './reviewInventory';

export interface EvidenceRequest {
  readonly files: readonly string[];
  readonly reason: string;
}
export interface EvidenceScope {
  readonly inventory: readonly string[];
  readonly omittedDirectories: readonly string[];
  readonly architecture: readonly ArchitectureModule[];
  readonly component?: ComponentContext;
  readonly requests: readonly EvidenceRequest[];
}
interface EvidenceConfig {
  readonly root: string;
  readonly blocks: readonly ReviewRequest[];
  readonly loadModules: () => Promise<readonly ArchitectureModule[]>;
  readonly startWithComponent: boolean;
}
interface EvidenceResult { readonly output: unknown; readonly scope: EvidenceScope }
const MAX_EXPANSIONS = 2;
const isReason = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 1600;

/** An answer with `needsContext` is an evidence request, whatever else it contains: its verdict or findings are ignored. */
const requestedEvidence = (output: unknown): EvidenceRequest | undefined => {
  if (!isRecord(output) || !Object.hasOwn(output, 'needsContext')) { return undefined; }
  const request = output['needsContext'];
  if (!isRecord(request) || Object.keys(request).length !== 2) {
    throw new Error('Reviewer returned an invalid evidence request');
  }
  const files = parseArray(request['files'], (path) => typeof path === 'string' && path.length <= 4096 ? path : undefined);
  const reason = request['reason'];
  if (files === undefined || files.length > 20 || !isReason(reason)) {
    throw new Error('Reviewer returned an invalid evidence request');
  }
  return { files: [...new Set(files)], reason };
};

const initialScope = async (config: EvidenceConfig): Promise<EvidenceScope> => {
  if (config.startWithComponent) {
    const architecture = await config.loadModules();
    const component = await collectComponentContext(config.root, config.blocks, architecture);
    return { inventory: component.inventory, omittedDirectories: component.omittedDirectories, architecture, component, requests: [] };
  }
  const inventory = await reviewInventory(config.root);
  return { inventory: inventory.paths, omittedDirectories: inventory.omittedDirectories, architecture: [], requests: [] };
};

const expand = async (config: EvidenceConfig, scope: EvidenceScope, request: EvidenceRequest): Promise<EvidenceScope> => {
  const known = new Set(scope.inventory);
  if (request.files.some((path) => !known.has(path))) {
    throw new Error('Reviewer needs evidence outside the eligible source inventory; review remains incomplete');
  }
  const supplied = new Set(scope.component?.files.map((file) => file.path) ?? []);
  if (scope.component !== undefined && request.files.every((path) => supplied.has(path))) {
    throw new Error('Reviewer requested evidence already supplied; review remains incomplete');
  }
  const architecture = scope.component === undefined ? await config.loadModules() : scope.architecture;
  const requests = [...scope.requests, request];
  const requestedPaths = [...new Set(requests.flatMap((entry) => entry.files))];
  const component = await collectComponentContext(config.root, config.blocks, architecture, requestedPaths);
  return { inventory: component.inventory, omittedDirectories: component.omittedDirectories, architecture, component, requests };
};

/** No speculative verdict is substituted when evidence is unsafe, unavailable, repeated or still insufficient. */
export const reviewWithEvidence = async (
  config: EvidenceConfig, ask: (scope: EvidenceScope) => Promise<unknown>,
): Promise<EvidenceResult> => {
  let scope = await initialScope(config);
  for (let round = 0; round <= MAX_EXPANSIONS; round++) {
    const output = await ask(scope);
    const request = requestedEvidence(output);
    if (request === undefined) { return { output, scope }; }
    if (round === MAX_EXPANSIONS) {
      throw new Error('Reviewer still needs evidence after two expansions; review remains incomplete');
    }
    scope = await expand(config, scope, request);
  }
  throw new Error('Evidence review ended without a verdict');
};
