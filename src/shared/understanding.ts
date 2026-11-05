/** A quote is evidence for an agent interpretation. Only an explicit developer action confirms intent. */
import { isRecord, readStrings } from './guards';
import { isView } from './diagram';

export interface SubjectExplanation { readonly symbol: string; readonly summary: string; readonly evidence: string; readonly view: string; readonly reason: string }
const explanationFields = ['symbol', 'summary', 'evidence', 'view', 'reason'] as const;
export const explanationsOf = (value: unknown): SubjectExplanation[] => {
  if (!Array.isArray(value)) { return []; }
  const entries: readonly unknown[] = value;
  return entries.slice(0, 30).flatMap((entry) => {
    const fields = isRecord(entry) ? readStrings(entry, explanationFields) : undefined;
    return fields !== undefined && isView(fields.view) && fields.symbol.trim() !== '' && Object.values(fields).every((text) => text.length <= 600) ? [fields] : [];
  });
};

export interface ModelClaim { readonly view:string; readonly title:string; readonly from:string; readonly to:string; readonly label:string; readonly evidence:string; readonly summary?:string; readonly fromSummary?:string; readonly toSummary?:string }
const claimKinds=new Set(['architecture','workflow','sequence','dataflow','lifecycle']);
const claimFields=['view','title','from','to','label','evidence'] as const;
const parseClaim=(v:unknown):ModelClaim|undefined=>{
  const claim=isRecord(v)?readStrings(v,claimFields):undefined;
  if(claim===undefined||!claimKinds.has(claim.view)){return undefined;}
  if (!Object.values(claim).every(s=>s.length<=600)||![claim.title,claim.from,claim.to,claim.label].every(s=>s.trim()!=='')) { return undefined; }
  const extra = isRecord(v) ? Object.fromEntries(['summary', 'fromSummary', 'toSummary'].flatMap((key) => typeof v[key] === 'string' && v[key].length <= 600 ? [[key, v[key]]] : [])) : {};
  return { ...claim, ...extra };
};
export const claimsOf=(v:unknown):ModelClaim[]=>{
  if(!Array.isArray(v)){return [];}
  const values:readonly unknown[]=v;
  return values.slice(0,12).flatMap(x=>parseClaim(x)??[]);
};
export interface Interpretation {
  readonly explanations?: readonly SubjectExplanation[];
  readonly claims?: readonly ModelClaim[];
  readonly role?: string;
  readonly what: string;
  readonly whatEvidence: string;
  readonly why: string;
  readonly whyEvidence: string;
  readonly question: string;
}
export interface Understanding extends Interpretation { readonly confirmed?: string }
const interpretationExtras = (v: unknown): Pick<Interpretation, 'role' | 'claims' | 'explanations'> => {
  if (!isRecord(v)) { return {}; }
  const role = v['role'], claims = claimsOf(v['claims']), explanations = explanationsOf(v['explanations']);
  return { ...(typeof role === 'string' && role.length <= 100 ? { role } : {}), ...(claims.length > 0 ? { claims } : {}), ...(explanations.length > 0 ? { explanations } : {}) };
};
export const parseInterpretation = (v: unknown): Interpretation | undefined => {
  const fields = isRecord(v) ? readStrings(v, ['what', 'whatEvidence', 'why', 'whyEvidence', 'question']) : undefined;
  if (fields === undefined || Object.values(fields).some((s) => s.length > 1600)) { return undefined; }
  return { ...fields, ...interpretationExtras(v) };
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
/**
 * The longest text MALT keeps in each field of an interpretation (`ground`, `sanitizeModules`). The schema states
 * them as maxLength, so the model writes within them instead of producing text that is cut off or rejected.
 */
export const INTERPRETATION_LIMITS = {
  text: 800, question: 400, quote: 600, role: 100, symbol: 120, summary: 600, reason: 400, name: 100, label: 200,
} as const;
const text = (maxLength: number): { readonly type: 'string'; readonly maxLength: number } => ({ type: 'string', maxLength });
const L = INTERPRETATION_LIMITS;
export const interpretationSchema = {
  type: 'object',
  properties: {
    explanations: { type: 'array', maxItems: 30, items: { type: 'object', properties: {
      symbol: text(L.symbol), summary: text(L.summary), evidence: text(L.quote), view: { type: 'string' }, reason: text(L.reason),
    }, required: explanationFields, additionalProperties: false } },
    claims: { type: 'array', maxItems: 12, items: { type: 'object', properties: {
      view: { type: 'string' }, title: text(L.name), from: text(L.name), to: text(L.name), label: text(L.label), evidence: text(L.quote),
      summary: text(L.summary), fromSummary: text(L.summary), toSummary: text(L.summary),
    }, required: claimFields, additionalProperties: false } },
    role: text(L.role), what: text(L.text), whatEvidence: text(L.quote), why: text(L.text),
    whyEvidence: text(L.quote), question: text(L.question),
  },
  required: ['what', 'whatEvidence', 'why', 'whyEvidence', 'question'],
  additionalProperties: false,
};
