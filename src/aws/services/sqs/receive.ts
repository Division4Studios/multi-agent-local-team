import { randomUUID } from 'node:crypto';
import { invalid } from '../../protocol/errors';
import { fields, list, text } from '../../protocol/values';
import type { MessageState, QueueState } from './types';
import { md5, numeric, prune } from './messages';

const SYSTEM_ATTRIBUTES = ['SenderId', 'SentTimestamp', 'ApproximateFirstReceiveTimestamp', 'ApproximateReceiveCount'];
export interface ReceiveOptions { readonly maximum: number; readonly visibility: number; readonly wait: number; readonly attributes: readonly string[] }
const selections = (input: Readonly<Record<string, unknown>>): readonly string[] => {
  const selected = new Set<string>();
  for (const name of ['AttributeNames', 'MessageSystemAttributeNames']) {
    if (input[name] === undefined) { continue; }
    for (const value of list(input[name]).map(text)) {
      if (value === 'All') { SYSTEM_ATTRIBUTES.forEach(item => selected.add(item)); }
      else if (SYSTEM_ATTRIBUTES.includes(value)) { selected.add(value); }
      else { throw invalid('Unsupported message system attribute selection'); }
    }
  }
  return [...selected];
};
export const receiveOptions = (queue: QueueState, input: Readonly<Record<string, unknown>>): ReceiveOptions => {
  fields(input, ['QueueUrl', 'MaxNumberOfMessages', 'VisibilityTimeout', 'WaitTimeSeconds', 'AttributeNames', 'MessageSystemAttributeNames']);
  return {
    maximum: numeric(input, 'MaxNumberOfMessages', [1, 10], 1),
    visibility: numeric(input, 'VisibilityTimeout', [0, 43200], Number(queue.attributes.VisibilityTimeout)),
    wait: numeric(input, 'WaitTimeSeconds', [0, 20], Number(queue.attributes.ReceiveMessageWaitTimeSeconds)),
    attributes: selections(input),
  };
};
const delivery = (message: MessageState, options: ReceiveOptions, account: string, now: number): Readonly<Record<string, unknown>> => {
  if (message.receiveCount === Number.MAX_SAFE_INTEGER) { throw invalid('Message receive count is exhausted'); }
  if (message.currentReceipt !== undefined) { message.oldReceipts.push(message.currentReceipt); }
  message.currentReceipt = randomUUID();
  message.firstReceivedAt ??= now;
  message.receiveCount += 1;
  message.availableAt = now + options.visibility * 1000;
  const attributes: Readonly<Record<string, string>> = {
    SenderId: account, SentTimestamp: String(message.sentAt), ApproximateFirstReceiveTimestamp: String(message.firstReceivedAt),
    ApproximateReceiveCount: String(message.receiveCount),
  };
  return { MessageId: message.id, Body: message.body, MD5OfBody: md5(message.body), ReceiptHandle: message.currentReceipt,
    ...(options.attributes.length === 0 ? {} : { Attributes: Object.fromEntries(options.attributes.map(key => [key, attributes[key]])) }) };
};
export const receiveNow = (queue: QueueState, options: ReceiveOptions, account: string, now: number): Readonly<Record<string, unknown>> => {
  prune(queue, now);
  const available = queue.messages.filter(message => message.availableAt <= now).slice(0, options.maximum);
  if (available.some(message => message.receiveCount === Number.MAX_SAFE_INTEGER)) { throw invalid('Message receive count is exhausted'); }
  return available.length === 0 ? {} : { Messages: available.map(message => delivery(message, options, account, now)) };
};
export const nextAvailability = (queue: QueueState, now: number, remaining: number): number =>
  queue.messages.reduce((wait, message) => message.availableAt > now && message.availableAt < message.expiresAt
    ? Math.min(wait, message.availableAt - now) : wait, remaining);
