/** Strict admin wire boundary: every parser returns detached data or undefined. */
import { isRecord, parseArray, readStrings } from '../guards';
import type { AwsCoverage, AwsHealth, AwsOperationCoverage, AwsTrace, AwsTraces, OperationStatus } from './types';
import { exactKeys, parseScope, safeCount, testKind } from './validation';
export { parseAwsQueueResource, parseAwsResources } from './resources';

const serviceName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z][a-z0-9-]*$/u.exec(value)?.[0] === value;
const operationName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.exec(value)?.[0] === value;
const statusValue = (value: unknown): value is OperationStatus =>
  value === 'unsupported' || value === 'stubbed' || value === 'partial' || value === 'verified' || value === 'simulated';
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const responseCode = (value: unknown): value is number => safeCount(value) && value >= 100 && value <= 599;
export const parseAwsHealth = (value: unknown): AwsHealth | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['status', 'requestCount', 'services'])) { return undefined; }
  const requestCount = value['requestCount'];
  const services = parseArray(value['services'], item => serviceName(item) ? item : undefined);
  if (value['status'] !== 'running' || !safeCount(requestCount) || services === undefined) { return undefined; }
  return services.length === 2 && services.includes('sqs') && services.includes('sts')
    ? { status: 'running', requestCount, services } : undefined;
};
const operation = (value: unknown): AwsOperationCoverage | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['operation', 'status', 'testKinds', 'limitations'])) { return undefined; }
  const name = value['operation'];
  const status = value['status'];
  const testKinds = parseArray(value['testKinds'], item => testKind(item) ? item : undefined);
  const limitations = parseArray(value['limitations'], item => typeof item === 'string' ? item : undefined);
  if (!operationName(name) || !statusValue(status) || testKinds === undefined || limitations === undefined) { return undefined; }
  return { operation: name, status, testKinds, limitations };
};
const service = (value: unknown): AwsCoverage['services'][number] | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['service', 'operations'])) { return undefined; }
  const name = value['service'];
  const operations = parseArray(value['operations'], operation);
  return serviceName(name) && operations !== undefined ? { service: name, operations } : undefined;
};
export const parseAwsCoverage = (value: unknown): AwsCoverage | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['services'])) { return undefined; }
  const services = parseArray(value['services'], service);
  return services === undefined ? undefined : { services };
};
export const parseAwsTrace = (value: unknown): AwsTrace | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['id', 'service', 'operation', 'account', 'region', 'principalArn', 'identity', 'statusCode', 'durationMs', 'decision'])) { return undefined; }
  const strings = readStrings(value, ['id', 'service', 'operation', 'principalArn', 'decision']);
  const scope = parseScope({ account: value['account'], region: value['region'] });
  const statusCode = value['statusCode'];
  const durationMs = value['durationMs'];
  if (strings === undefined || scope === undefined || value['identity'] !== 'default-root') { return undefined; }
  return responseCode(statusCode) && duration(durationMs)
    ? { ...strings, ...scope, identity: 'default-root', statusCode, durationMs } : undefined;
};
export const parseAwsTraces = (value: unknown): AwsTraces | undefined => {
  if (!isRecord(value) || !exactKeys(value, ['traces'])) { return undefined; }
  const traces = parseArray(value['traces'], parseAwsTrace);
  return traces === undefined ? undefined : { traces };
};
export const parseAwsAcknowledgement = (value: unknown, key: 'saved' | 'reset' | 'stopping'): boolean =>
  isRecord(value) && exactKeys(value, [key]) && value[key] === true;
