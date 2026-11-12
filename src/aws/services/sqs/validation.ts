import { Buffer } from 'node:buffer';
import { httpOrigin, parseAttributes, validQueueName } from '../../../shared/aws/validation';
import type { QueueAttributes } from '../../../shared/aws/types';
import { AwsError, invalid } from '../../protocol/errors';
import { text } from '../../protocol/values';
import type { AccountRegion } from '../types';

export const queueName = (value: unknown): string => {
  if (!validQueueName(value)) { throw invalid('Invalid standard queue name'); }
  return value;
};
export const attributes = (value: unknown, partial = true): QueueAttributes => {
  const result = parseAttributes(value, partial);
  if (result === undefined) { throw new AwsError('InvalidAttributeValue', 'Unknown, unsupported or invalid queue attributes'); }
  return result;
};
export const messageBody = (value: unknown, limit: number): string => {
  const body = text(value);
  for (const character of body) {
    const code = character.codePointAt(0) ?? 0;
    if (!validCharacter(code)) { throw new AwsError('InvalidMessageContents', 'Message contains an invalid Unicode code point'); }
  }
  if (body.length === 0 || Buffer.byteLength(body, 'utf8') > limit) { throw invalid('Message body size outside queue limits'); }
  return body;
};
const validCharacter = (code: number): boolean => code === 9 || code === 10 || code === 13
  || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
export const queueUrl = (endpoint: string, scope: AccountRegion, name: string): string =>
  `${endpoint}/${scope.account}/${scope.region}/${name}`;
export const nameFromUrl = (value: unknown, endpoint: string, scope: AccountRegion): string => {
  const url = text(value);
  const prefix = `${endpoint}/${scope.account}/${scope.region}/`;
  if (!url.startsWith(prefix)) { throw invalid('QueueUrl origin or scope does not match this local endpoint'); }
  return queueName(url.slice(prefix.length));
};
export const endpointOrigin = (endpoint: string): string => httpOrigin(endpoint);
