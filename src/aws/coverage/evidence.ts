import { isRecord, parseArray } from '../../shared/guards';
import { exactKeys, testKind } from '../../shared/aws/validation';
import type { EvidenceCase } from '../../shared/aws/types';
export type { EvidenceCase } from '../../shared/aws/types';
export { runtimeDigest } from './digest';

export const validOperationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9-]*\.[A-Za-z][A-Za-z0-9]*$/u.exec(value)?.[0] === value;
const evidenceCase = (value: unknown): EvidenceCase | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['id', 'operations', 'kind'])) { return undefined; }
  const id = value['id'];
  const kind = value['kind'];
  const operations = parseArray(value['operations'], item => validOperationId(item) ? item : undefined);
  if (typeof id !== 'string' || id.length === 0 || !testKind(kind) || operations === undefined || operations.length === 0) { return undefined; }
  return new Set(operations).size === operations.length ? { id, operations, kind } : undefined;
};
export const parseEvidence = (value: unknown, expectedDigest: string): readonly EvidenceCase[] | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['formatVersion', 'runtimeDigest', 'cases'])) { return undefined; }
  const digest = value['runtimeDigest'];
  if (value['formatVersion'] !== 1 || typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest) || digest !== expectedDigest) { return undefined; }
  const cases = parseArray(value['cases'], evidenceCase);
  return new Set(cases?.map(item => item.id)).size === cases?.length ? cases : undefined;
};
