import { parseScope, scopeKey } from '../../shared/aws/validation';
import { fields, record } from '../protocol/values';
import type { AccountRegion, StateDocument } from './types';

export const stateData = (value: unknown, service: string, scope: AccountRegion): unknown => {
  const document = record(value);
  fields(document, ['formatVersion', 'service', 'scope', 'data']);
  const parsed = parseScope(document['scope']);
  if (document['formatVersion'] !== 1 || document['service'] !== service || parsed === undefined
    || scopeKey(parsed) !== scopeKey(scope) || parseScope({ account: scope.account, region: scope.region }) === undefined) {
    throw new Error('Invalid state document version, service or scope');
  }
  return document['data'];
};
export const stateDocument = (service: string, scope: AccountRegion, data: unknown): StateDocument =>
  ({ formatVersion: 1, service, scope: { account: scope.account, region: scope.region }, data });
