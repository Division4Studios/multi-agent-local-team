/**
 * Gap investigations: a second, deeper review of one standards gap that reads the actual code before deciding
 * whether the gap is real. Shared by the reviewer (which produces them) and the extension (which saves and shows
 * them). Everything crossing the boundary goes through these parsers.
 */
import { createHash } from 'node:crypto';
import { isRecord, isString, parseArray, readStrings } from './guards';
import type { Finding } from './protocol';

export const INVESTIGATIONS_FILE = '.malt/investigations.json';

/** Is the gap real? `partly`: real but narrower or different than the scan described. */
export type GapVerdict = 'confirmed' | 'partly' | 'not-a-gap';
export type Confidence = 'high' | 'medium' | 'low';

/** A verbatim excerpt of the code that supports (or undercuts) the gap, checked by MALT against the file. */
export interface Evidence {
  readonly file: string;
  /** The declaration the excerpt belongs to; may be empty. */
  readonly symbol: string;
  readonly quote: string;
  readonly observation: string;
}

export interface GapInvestigation {
  readonly gapId: string;
  readonly investigatedAt: string;
  readonly verdict: GapVerdict;
  readonly confidence: Confidence;
  /** One or two sentences a teammate who has not seen the code can understand. */
  readonly plainSummary: string;
  readonly whatTheCodeDoes: string;
  readonly evidence: readonly Evidence[];
  /** The strongest case that this is not a gap (or is intended), so the reader can judge. */
  readonly counterpoints: string;
  readonly whyItMatters: string;
  readonly recommendation: string;
  /** The files MALT gave the reviewer, so the reader knows what was and was not looked at. */
  readonly filesRead: readonly string[];
}

export interface InvestigationsDocument {
  readonly version: 1;
  readonly investigations: readonly GapInvestigation[];
}

const VERDICTS: readonly GapVerdict[] = ['confirmed', 'partly', 'not-a-gap'];
const CONFIDENCES: readonly Confidence[] = ['high', 'medium', 'low'];

export const isGapVerdict = (value: unknown): value is GapVerdict => VERDICTS.some((verdict) => verdict === value);
export const isConfidence = (value: unknown): value is Confidence => CONFIDENCES.some((confidence) => confidence === value);

/**
 * A gap's identity: a hash of its content, so a saved investigation stays attached to the same gap across rescans
 * and is dropped when the gap's description changes. The reviewer looks gaps up by this id, so a caller can only
 * name a gap the scan recorded, never supply one.
 */
export const gapId = (gap: Finding): string =>
  createHash('sha256').update(JSON.stringify([gap.title, gap.files, gap.note, gap.detail])).digest('hex').slice(0, 24);

const GAP_ID = /^[a-f0-9]{24}$/u;

export const isGapId = (value: unknown): value is string => isString(value) && GAP_ID.test(value);

const parseEvidence = (value: unknown): Evidence | undefined =>
  isRecord(value) ? readStrings(value, ['file', 'symbol', 'quote', 'observation']) : undefined;

export const parseGapInvestigation = (value: unknown): GapInvestigation | undefined => {
  if (!isRecord(value) || !isGapId(value['gapId']) || !isGapVerdict(value['verdict']) || !isConfidence(value['confidence'])) {
    return undefined;
  }
  const strings = readStrings(value, ['investigatedAt', 'plainSummary', 'whatTheCodeDoes', 'counterpoints', 'whyItMatters', 'recommendation']);
  const evidence = parseArray(value['evidence'], parseEvidence);
  const filesRead = parseArray(value['filesRead'], (item) => (isString(item) ? item : undefined));
  if (strings === undefined || evidence === undefined || filesRead === undefined) {
    return undefined;
  }
  return { ...strings, gapId: value['gapId'], verdict: value['verdict'], confidence: value['confidence'], evidence, filesRead };
};

export const parseInvestigationsDocument = (value: unknown): InvestigationsDocument | undefined => {
  if (!isRecord(value) || value['version'] !== 1) {
    return undefined;
  }
  const investigations = parseArray(value['investigations'], parseGapInvestigation);
  return investigations === undefined ? undefined : { version: 1, investigations };
};

export const VERDICT_LABELS: Readonly<Record<GapVerdict, string>> = {
  confirmed: 'Confirmed gap',
  partly: 'Partly a gap',
  'not-a-gap': 'Not a gap',
};
