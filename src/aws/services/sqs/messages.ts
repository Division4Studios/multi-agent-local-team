import { createHash, randomUUID } from 'node:crypto';
import { AwsError } from '../../protocol/errors';
import { fields, integer, text } from '../../protocol/values';
import type { QueueState } from './types';
import { messageBody } from './validation';

export const md5 = (body: string): string => createHash('md5').update(body, 'utf8').digest('hex');
export const numeric = (input: Readonly<Record<string, unknown>>, name: string, bounds: readonly [number, number], fallback: number): number =>
  input[name] === undefined ? fallback : integer(input[name], bounds[0], bounds[1]);
export const prune = (queue: QueueState, now: number): void => {
  queue.messages = queue.messages.filter(message => message.expiresAt > now);
};
export const sendMessage = (queue: QueueState, input: Readonly<Record<string, unknown>>, now: number): Readonly<Record<string, unknown>> => {
  fields(input, ['QueueUrl', 'MessageBody', 'DelaySeconds']);
  const body = messageBody(input['MessageBody'], Number(queue.attributes.MaximumMessageSize));
  const delay = numeric(input, 'DelaySeconds', [0, 900], Number(queue.attributes.DelaySeconds));
  const id = randomUUID();
  queue.messages.push({ id, body, sentAt: now, availableAt: now + delay * 1000,
    expiresAt: now + Number(queue.attributes.MessageRetentionPeriod) * 1000, receiveCount: 0, oldReceipts: [] });
  return { MessageId: id, MD5OfMessageBody: md5(body) };
};
export const deleteMessage = (queue: QueueState, input: Readonly<Record<string, unknown>>, now: number): Readonly<Record<string, unknown>> => {
  fields(input, ['QueueUrl', 'ReceiptHandle']);
  const receipt = text(input['ReceiptHandle']);
  prune(queue, now);
  const current = queue.messages.find(message => message.currentReceipt === receipt);
  if (current !== undefined) {
    queue.messages = queue.messages.filter(message => message !== current);
    return {};
  }
  if (!queue.messages.some(message => message.oldReceipts.includes(receipt))) {
    throw new AwsError('ReceiptHandleIsInvalid', 'Receipt is not known to this queue', 404);
  }
  return {};
};
