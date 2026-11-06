/** Static evidence-request policy and schema, kept separate from the source-reading loop. */
import type { EvidenceScope } from './evidenceReview';
import { dataBlock } from './trust';

export const REQUEST_EVIDENCE = [
  'Before deciding, assess whether the supplied evidence is sufficient for this particular check.',
  'If a required implementation, caller or wider component context is missing, do not decide. Add a needsContext',
  'object instead, for example "needsContext":{"files":["exact/path/from/inventory.ts"],"reason":"What must be',
  'established before deciding"}, set status to "needs-context" (rule checks) or leave findings empty (consolidation).',
  'MALT ignores any verdict or findings in an answer that requests evidence.',
  'Choose up to 20 exact eligible source paths from the review-evidence inventory. Use an empty files array to request',
  'complete component context when the current call only has a short file window. Never request secrets, data files,',
  'invented paths or evidence already supplied: the review-evidence "supplied" list names every file whose complete',
  'source is already in component-context, and when component-context is present there is no fuller context to request.',
  'A previous request marked "alreadySupplied" asked only for evidence you already had; decide from the supplied evidence.',
  'MALT permits at most two evidence expansions and then stops the review',
  'as incomplete if essential evidence is still unavailable. Do not substitute a pass or a speculative fail for missing evidence.',
].join('\n');

/**
 * The optional `needsContext` property of the check and consolidation schemas. The API refuses `anyOf`, `oneOf` and
 * `allOf` at the top level of a tool schema, so a request is a property of the one answer object, not an alternative
 * to it. An answer containing it is an evidence request; any verdict or findings in it are ignored.
 */
export const NEEDS_CONTEXT_PROPERTY = {
  type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, maxItems: 20 }, reason: { type: 'string', maxLength: 1600 } },
  required: ['files', 'reason'], additionalProperties: false,
};

export const evidenceBlock = (nonce: string, evidence: EvidenceScope | undefined): string[] =>
  evidence === undefined ? [] : [dataBlock(nonce, 'review-evidence (untrusted json)', JSON.stringify({
    inventory: evidence.inventory, omittedDirectories: evidence.omittedDirectories, requests: evidence.requests,
    supplied: evidence.component?.files.map((file) => file.path) ?? [],
    expansionsRemaining: 2 - evidence.requests.length,
  }))];
