import type { ModelShape } from '../models/model';
import { invalid } from './errors';
import { integer, text } from './values';

const INTEGER_BOUNDS: Readonly<Record<string, readonly [number, number]>> = {
  byte: [-128, 127], short: [-32768, 32767], integer: [-2147483648, 2147483647], long: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};
export const primitive = (model: ModelShape, value: unknown, query = false): string | number | boolean => {
  if (model.type === 'string' || model.type === 'enum' || model.type === 'blob') { return text(value); }
  if (model.type === 'boolean') { return booleanValue(value, query); }
  const bounds = INTEGER_BOUNDS[model.type];
  if (bounds !== undefined) { return integer(query ? queryNumber(value) : value, bounds[0], bounds[1]); }
  throw invalid(`Unsupported ${model.type} protocol binding`);
};
const booleanValue = (value: unknown, query: boolean): boolean => {
  if (typeof value === 'boolean') { return value; }
  if (query && (value === 'true' || value === 'false')) { return value === 'true'; }
  throw invalid('Expected a boolean');
};
const queryNumber = (value: unknown): unknown =>
  typeof value === 'string' && /^-?[0-9]+$/u.exec(value)?.[0] === value ? Number(value) : value;
