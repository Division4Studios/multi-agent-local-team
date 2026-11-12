import { fields, integer, list, record, text } from '../../protocol/values';
import { invalid } from '../../protocol/errors';
import { stateData } from '../state';
import type { AccountRegion } from '../types';
import type { MessageState, QueueState } from './types';
import { attributes, messageBody, queueName } from './validation';

const opaque = (value: unknown): string => {
  const result = text(value);
  if (result.length === 0 || result.length > 2048 || /[\p{Cc}]/u.test(result)) { throw invalid('Invalid state identity'); }
  return result;
};
const time = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !Number.isFinite(value)) {
    throw invalid('Invalid state timestamp');
  }
  return value;
};
const receiptState = (value: Readonly<Record<string, unknown>>, message: MessageState): void => {
  if (message.receiveCount === 0) {
    if (Object.hasOwn(value, 'firstReceivedAt') || Object.hasOwn(value, 'currentReceipt') || message.oldReceipts.length !== 0) {
      throw invalid('Invalid unreceived message state');
    }
    return;
  }
  message.firstReceivedAt = time(value['firstReceivedAt']);
  message.currentReceipt = opaque(value['currentReceipt']);
  if (message.firstReceivedAt < message.sentAt || message.oldReceipts.length !== message.receiveCount - 1) {
    throw invalid('Invalid receipt state relationship');
  }
};
const parseMessage = (value: unknown, queue: QueueState): MessageState => {
  const source = record(value);
  fields(source, ['id', 'body', 'sentAt', 'availableAt', 'expiresAt', 'receiveCount', 'firstReceivedAt', 'currentReceipt', 'oldReceipts']);
  const message: MessageState = {
    id: opaque(source['id']), body: messageBody(source['body'], Number(queue.attributes.MaximumMessageSize)),
    sentAt: time(source['sentAt']), availableAt: time(source['availableAt']), expiresAt: time(source['expiresAt']),
    receiveCount: integer(source['receiveCount'], 0, Number.MAX_SAFE_INTEGER), oldReceipts: list(source['oldReceipts']).map(opaque),
  };
  if (message.availableAt < message.sentAt || message.expiresAt <= message.sentAt
    || message.expiresAt !== message.sentAt + Number(queue.attributes.MessageRetentionPeriod) * 1000) {
    throw invalid('Invalid state timestamp relationship');
  }
  receiptState(source, message);
  return message;
};
const uniqueIdentities = (messages: readonly MessageState[]): void => {
  const ids = new Set<string>();
  const receipts = new Set<string>();
  for (const message of messages) {
    if (ids.has(message.id)) { throw invalid('Duplicate message identity'); }
    ids.add(message.id);
    const known = message.currentReceipt === undefined ? message.oldReceipts : [...message.oldReceipts, message.currentReceipt];
    for (const receipt of known) {
      if (receipts.has(receipt)) { throw invalid('Duplicate receipt identity'); }
      receipts.add(receipt);
    }
  }
};
export const parseQueues = (document: unknown, scope: AccountRegion): Map<string, QueueState> => {
  const data = record(stateData(document, 'sqs', scope));
  fields(data, ['queues']);
  const queues = new Map<string, QueueState>();
  for (const entry of list(data['queues'])) {
    const source = record(entry);
    fields(source, ['name', 'attributes', 'messages']);
    const queue: QueueState = { name: queueName(source['name']), attributes: attributes(source['attributes'], false), messages: [] };
    queue.messages = list(source['messages']).map(value => parseMessage(value, queue));
    uniqueIdentities(queue.messages);
    if (queues.has(queue.name)) { throw invalid('Duplicate queue name'); }
    queues.set(queue.name, queue);
  }
  return queues;
};
export const copyQueue = (queue: QueueState): QueueState => ({
  name: queue.name, attributes: { ...queue.attributes },
  messages: queue.messages.map(message => ({ ...message, oldReceipts: [...message.oldReceipts] })),
});
