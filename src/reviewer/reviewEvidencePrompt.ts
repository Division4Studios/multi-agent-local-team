/** Static evidence-request policy and schema, kept separate from the source-reading loop. */
import type { EvidenceScope } from './evidenceReview';
import { dataBlock } from './trust';

export const REQUEST_EVIDENCE = [
  'Before deciding, assess whether the supplied evidence is sufficient for this particular check.',
  'If a required implementation, caller or wider component context is missing, return only',
  '{"needsContext":{"files":["exact/path/from/inventory.ts"],"reason":"What must be established before deciding"}}.',
  'Choose up to 20 exact eligible source paths from the review-evidence inventory. Use an empty files array to request',
  'complete component context when the current call only has a short file window. Never request secrets, data files,',
  'invented paths or evidence already supplied. MALT permits at most two evidence expansions and then stops the review',
  'as incomplete if essential evidence is still unavailable. Do not substitute a pass or a speculative fail for missing evidence.',
].join('\n');

export const EVIDENCE_REQUEST_SCHEMA = {
  type: 'object', properties: {
    needsContext: {
      type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, maxItems: 20 }, reason: { type: 'string', maxLength: 1600 } },
      required: ['files', 'reason'], additionalProperties: false,
    },
  }, required: ['needsContext'], additionalProperties: false,
};

export const evidenceBlock = (nonce: string, evidence: EvidenceScope | undefined): string[] =>
  evidence === undefined ? [] : [dataBlock(nonce, 'review-evidence (untrusted json)', JSON.stringify({
    inventory: evidence.inventory, omittedDirectories: evidence.omittedDirectories, requests: evidence.requests,
    expansionsRemaining: 2 - evidence.requests.length,
  }))];
