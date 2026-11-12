import { isRecord } from '../guards';
import type { AccountRegion, QueueAttributeName, QueueAttributes, TestKind } from './types';

export const onlyKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).every(key => keys.includes(key));
export const exactKeys = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  onlyKeys(value, keys) && keys.every(key => Object.hasOwn(value, key));
export const safeCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const validRegion = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9-]+$/u.exec(value)?.[0] === value;
export const validQueueName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/u.exec(value)?.[0] === value;
export const parseScope = (value: unknown): AccountRegion | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['account', 'region'])) {
    return undefined;
  }
  const account = value['account'];
  const region = value['region'];
  return typeof account === 'string' && /^[0-9]{12}$/u.exec(account)?.[0] === account && validRegion(region)
    ? { account, region } : undefined;
};
export const scopeKey = (scope: AccountRegion): string => `${scope.account}/${scope.region}`;
export const testKind = (value: unknown): value is TestKind =>
  value === 'unit' || value === 'protocol' || value === 'lifecycle' || value === 'workflow' || value === 'differential';

interface AttributeRule { readonly name: QueueAttributeName; readonly min: number; readonly max: number }
export const ATTRIBUTE_RULES: readonly AttributeRule[] = [
  { name: 'VisibilityTimeout', min: 0, max: 43200 }, { name: 'DelaySeconds', min: 0, max: 900 },
  { name: 'MessageRetentionPeriod', min: 60, max: 1209600 }, { name: 'MaximumMessageSize', min: 1024, max: 1048576 },
  { name: 'ReceiveMessageWaitTimeSeconds', min: 0, max: 20 },
];
export const DEFAULT_ATTRIBUTES: QueueAttributes = {
  VisibilityTimeout: '30', DelaySeconds: '0', MessageRetentionPeriod: '345600',
  MaximumMessageSize: '1048576', ReceiveMessageWaitTimeSeconds: '0',
};
const attributeValue = (value: unknown, rule: AttributeRule): value is string =>
  typeof value === 'string' && /^[0-9]+$/u.exec(value)?.[0] === value && Number(value) >= rule.min && Number(value) <= rule.max;
export const parseAttributes = (value: unknown, partial = false): QueueAttributes | undefined => {
  const names = ATTRIBUTE_RULES.map(rule => rule.name);
  if (!isRecord(value) || !onlyKeys(value, names) || (!partial && !exactKeys(value, names))) {
    return undefined;
  }
  const result = { ...DEFAULT_ATTRIBUTES };
  for (const rule of ATTRIBUTE_RULES) {
    if (!Object.hasOwn(value, rule.name)) {
      continue;
    }
    const field = value[rule.name];
    if (!attributeValue(field, rule)) {
      return undefined;
    }
    result[rule.name] = String(Number(field));
  }
  return result;
};
export const httpOrigin = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '' || url.search !== ''
    || url.hash !== '' || url.pathname !== '/' || (value !== url.origin && value !== `${url.origin}/`)) {
    throw new Error('Invalid HTTP origin');
  }
  return url.origin;
};
