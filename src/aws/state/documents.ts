import { parseStrictJson } from '../../shared/aws/json';
import { exactKeys, parseScope, scopeKey } from '../../shared/aws/validation';
import { list, record } from '../protocol/values';
import type { AccountRegion, ServiceBackend, StateDocument } from '../services/types';

export interface ImportedDocument { readonly scope: AccountRegion; readonly service: string; readonly value: unknown }
export const parseDocuments = (bytes: Buffer | undefined): readonly ImportedDocument[] => {
  if (bytes === undefined) { return []; }
  const envelope = record(parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (!exactKeys(envelope, ['formatVersion', 'documents'])) { throw new Error('Invalid state envelope fields'); }
  if (envelope['formatVersion'] !== 1) { throw new Error('Unsupported state version'); }
  const seen = new Set<string>();
  return list(envelope['documents']).map(value => {
    const document = record(value);
    const scope = parseScope(document['scope']);
    const service = document['service'];
    if (scope === undefined || (service !== 'sts' && service !== 'sqs')) { throw new Error('Invalid state service or scope'); }
    const key = `${service}/${scopeKey(scope)}`;
    if (seen.has(key)) { throw new Error('Duplicate state document'); }
    seen.add(key);
    return { scope, service, value };
  });
};
export const importDocuments = (backends: readonly ServiceBackend[], documents: readonly ImportedDocument[]): void => {
  // These are unexposed startup instances; no listener serves them until all imports succeed.
  for (const document of documents) {
    const backend = backends.find(value => value.service === document.service);
    if (backend === undefined) { throw new Error('Invalid state service'); }
    backend.importState(document.scope, document.value);
  }
};
export const diskEnvelope = (documents: readonly StateDocument[]): unknown => ({ formatVersion: 1, documents });
