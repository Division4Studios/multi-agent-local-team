/** A quote is evidence for an agent interpretation. Only an explicit developer action confirms intent. */
import { isRecord, readStrings } from './guards';

export interface Interpretation {
  readonly what: string;
  readonly whatEvidence: string;
  readonly why: string;
  readonly whyEvidence: string;
  readonly question: string;
}
export interface Understanding extends Interpretation { readonly confirmed?: string }
export const parseInterpretation = (v: unknown): Interpretation | undefined => {
  const fields = isRecord(v) ? readStrings(v, ['what', 'whatEvidence', 'why', 'whyEvidence', 'question']) : undefined;
  return fields !== undefined && Object.values(fields).every((s) => s.length <= 1600) ? fields : undefined;
};
export const parseUnderstanding = (v: unknown): Understanding | undefined => {
  const fields = parseInterpretation(v);
  const confirmed = isRecord(v) ? v['confirmed'] : undefined;
  return fields !== undefined && typeof confirmed === 'string' && confirmed.length <= 1600 ? { ...fields, confirmed } : fields;
};

export interface DiscussionRequest {
  readonly path: string;
  readonly source: string;
  readonly context: string;
  readonly dialogue: string;
}
export const parseDiscussion = (v: unknown): DiscussionRequest | undefined => {
  const fields = isRecord(v) ? readStrings(v, ['path', 'source', 'context', 'dialogue']) : undefined;
  if (fields === undefined || fields.path.length > 4096 || fields.source.length > 48_000 || fields.context.length > 12_000 || fields.dialogue.length > 22_000) {
    return undefined;
  }
  return fields;
};
export const interpretationSchema = {
  type: 'object',
  properties: {
    what: { type: 'string' }, whatEvidence: { type: 'string' }, why: { type: 'string' },
    whyEvidence: { type: 'string' }, question: { type: 'string' },
  },
  required: ['what', 'whatEvidence', 'why', 'whyEvidence', 'question'],
  additionalProperties: false,
};
