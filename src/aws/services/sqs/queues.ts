import { scopeKey } from '../../../shared/aws/validation';
import { AwsError, invalid } from '../../protocol/errors';
import { fields } from '../../protocol/values';
import type { AccountRegion } from '../types';
import type { QueueState, QueueStore, ScopedQueues } from './types';
import { attributes, nameFromUrl, queueName, queueUrl } from './validation';

export const scopedQueues = (store: QueueStore, scope: AccountRegion): ScopedQueues => {
  return store.get(scopeKey(scope)) ?? { scope: { account: scope.account, region: scope.region }, queues: new Map() };
};
export const missingQueue = (): AwsError => new AwsError('QueueDoesNotExist', 'Queue does not exist in this account and region');
export const findQueue = (scope: ScopedQueues, value: unknown, endpoint: string): QueueState => {
  const name = nameFromUrl(value, endpoint, scope.scope);
  const found = scope.queues.get(name);
  if (found === undefined) { throw missingQueue(); }
  return found;
};
export const createQueue = (scope: ScopedQueues, input: Readonly<Record<string, unknown>>, endpoint: string): Readonly<Record<string, unknown>> => {
  fields(input, ['QueueName', 'Attributes']);
  const name = queueName(input['QueueName']);
  const settings = attributes(input['Attributes'] === undefined ? {} : input['Attributes']);
  const current = scope.queues.get(name);
  if (current !== undefined && JSON.stringify(current.attributes) !== JSON.stringify(settings)) {
    throw new AwsError('QueueNameExists', 'A queue with this name exists with different effective attributes');
  }
  if (current === undefined) { scope.queues.set(name, { name, attributes: settings, messages: [] }); }
  return { QueueUrl: queueUrl(endpoint, scope.scope, name) };
};
export const getQueueUrl = (scope: ScopedQueues, input: Readonly<Record<string, unknown>>, endpoint: string): Readonly<Record<string, unknown>> => {
  fields(input, ['QueueName', 'QueueOwnerAWSAccountId']);
  const name = input['QueueName'];
  if (typeof name !== 'string') { throw invalid('QueueName is required'); }
  if (input['QueueOwnerAWSAccountId'] !== undefined && input['QueueOwnerAWSAccountId'] !== scope.scope.account) {
    throw invalid('Cross-account queue access is unsupported');
  }
  if (!scope.queues.has(name)) { throw missingQueue(); }
  return { QueueUrl: queueUrl(endpoint, scope.scope, name) };
};
