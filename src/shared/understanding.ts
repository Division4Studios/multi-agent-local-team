/** A quote is evidence for an agent interpretation. Only an explicit developer action confirms intent. */
import { isRecord, readStrings } from './guards';

export interface ModelClaim { readonly view:string; readonly title:string; readonly from:string; readonly to:string; readonly label:string; readonly evidence:string }
const claimKinds=new Set(['architecture','workflow','sequence','dataflow','lifecycle']);
const claimFields=['view','title','from','to','label','evidence'] as const;
const parseClaim=(v:unknown):ModelClaim|undefined=>{
  const claim=isRecord(v)?readStrings(v,claimFields):undefined;
  if(claim===undefined||!claimKinds.has(claim.view)){return undefined;}
  return Object.values(claim).every(s=>s.length<=600)&&[claim.title,claim.from,claim.to,claim.label].every(s=>s.trim()!=='')?claim:undefined;
};
export const claimsOf=(v:unknown):ModelClaim[]=>{
  if(!Array.isArray(v)){return [];}
  const values:readonly unknown[]=v;
  return values.slice(0,12).flatMap(x=>parseClaim(x)??[]);
};
export interface Interpretation {
  readonly claims?: readonly ModelClaim[];
  readonly role?: string;
  readonly what: string;
  readonly whatEvidence: string;
  readonly why: string;
  readonly whyEvidence: string;
  readonly question: string;
}
export interface Understanding extends Interpretation { readonly confirmed?: string }
export const parseInterpretation = (v: unknown): Interpretation | undefined => {
  const fields = isRecord(v) ? readStrings(v, ['what', 'whatEvidence', 'why', 'whyEvidence', 'question']) : undefined;
  if (fields === undefined || Object.values(fields).some((s) => s.length > 1600)) { return undefined; }
  const role = isRecord(v) ? v['role'] : undefined;
  const claims = claimsOf(isRecord(v) ? v['claims'] : undefined);
  return { ...fields, ...(typeof role === 'string' && role.length <= 100 ? {role}:{}), ...(claims.length > 0 ? {claims}:{}) };
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
    claims: { type:'array', maxItems:12, items:{type:'object',properties:Object.fromEntries(claimFields.map(k=>[k,{type:'string'}])),required:claimFields,additionalProperties:false} },
    role: { type: 'string' }, what: { type: 'string' }, whatEvidence: { type: 'string' }, why: { type: 'string' },
    whyEvidence: { type: 'string' }, question: { type: 'string' },
  },
  required: ['what', 'whatEvidence', 'why', 'whyEvidence', 'question'],
  additionalProperties: false,
};
