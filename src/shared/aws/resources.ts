import { isRecord, parseArray } from '../guards';
import type { AwsQueueResource, AwsResources } from './types';
import { exactKeys, httpOrigin, parseAttributes, parseScope, safeCount, validQueueName } from './validation';

const messageCounts = (value: unknown): AwsQueueResource['details']['messageCounts'] | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['available', 'delayed', 'inFlight'])) { return undefined; }
  const available = value['available'];
  const delayed = value['delayed'];
  const inFlight = value['inFlight'];
  return safeCount(available) && safeCount(delayed) && safeCount(inFlight) ? { available, delayed, inFlight } : undefined;
};
const details = (value: unknown): AwsQueueResource['details'] | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['queueUrl', 'attributes', 'messageCounts'])) { return undefined; }
  const queueUrl = value['queueUrl'];
  const attributes = parseAttributes(value['attributes']);
  const counts = messageCounts(value['messageCounts']);
  return typeof queueUrl === 'string' && attributes !== undefined && counts !== undefined
    ? { queueUrl, attributes, messageCounts: counts } : undefined;
};
const scopedUrl = (value: string, account: string, region: string, name: string): boolean => {
  try {
    const url = new URL(value);
    return value === `${httpOrigin(url.origin)}/${account}/${region}/${name}`;
  } catch { return false; }
};
export const parseAwsQueueResource = (value: unknown): AwsQueueResource | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['service', 'account', 'region', 'type', 'name', 'id', 'details'])) { return undefined; }
  if (value['service'] !== 'sqs' || value['type'] !== 'queue') { return undefined; }
  const scope = parseScope({ account: value['account'], region: value['region'] });
  const name = value['name'];
  const parsed = details(value['details']);
  if (scope === undefined || !validQueueName(name) || parsed === undefined) { return undefined; }
  const id = `arn:aws:sqs:${scope.region}:${scope.account}:${name}`;
  if (value['id'] !== id || !scopedUrl(parsed.queueUrl, scope.account, scope.region, name)) { return undefined; }
  return { service: 'sqs', type: 'queue', ...scope, name, id, details: parsed };
};
export const parseAwsResources = (value: unknown): AwsResources | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['resources'])) { return undefined; }
  const resources = parseArray(value['resources'], parseAwsQueueResource);
  return resources === undefined ? undefined : { resources };
};
