import { isRecord } from '../../shared/guards';
import { onlyKeys } from '../../shared/aws/validation';
import { invalid } from './errors';

export const record = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) { throw invalid('Expected an object'); }
  return value;
};
export const fields = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): void => {
  if (!onlyKeys(value, keys)) { throw invalid('Unknown or unsupported member'); }
};
export const text = (value: unknown): string => {
  if (typeof value !== 'string') { throw invalid('Expected a string'); }
  return value;
};
export const integer = (value: unknown, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw invalid('Integer outside the supported range');
  }
  return value;
};
export const list = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) { throw invalid('Expected an array'); }
  return value;
};
