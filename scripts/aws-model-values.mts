import type { ModelObject, ModelTraits, ModelValue } from '../src/aws/models/model.ts';

export const modelError = (context: string, detail: string): Error => new Error(`Smithy model ${context}: ${detail}`);
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const record = (value: unknown, context: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw modelError(context, 'expected an object');
  }
  return value;
};

export const text = (value: unknown, context: string): string => {
  if (typeof value !== 'string') {
    throw modelError(context, 'expected a string');
  }
  return value;
};

export const identifier = (value: unknown, context: string): string => {
  const name = text(value, context);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || /\s/u.test(name)) {
    throw modelError(context, 'invalid member/shape identifier');
  }
  return name;
};

export const shapeId = (value: unknown, context: string): string => {
  const id = text(value, context);
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*#[A-Za-z_][A-Za-z0-9_]*$/u.test(id) || /\s/u.test(id)) {
    throw modelError(context, `invalid absolute shape ID ${JSON.stringify(id)}`);
  }
  return id;
};

export const array = (value: unknown, context: string): readonly unknown[] => {
  if (!Array.isArray(value)) {
    throw modelError(context, 'expected an array');
  }
  return value;
};

export const fields = (value: Record<string, unknown>, allowed: readonly string[], context: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw modelError(context, `unsupported field ${key}; provide a resolved Smithy AST`);
    }
  }
};

/** Copy only JSON data; bound nesting also rejects cycles without stack overflow. */
export const jsonValue = (value: unknown, context: string, depth = 0): ModelValue => {
  if (depth > 128) {
    throw modelError(context, 'JSON data is cyclic or exceeds 128 levels');
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => jsonValue(item, context, depth + 1));
  }
  return Object.fromEntries(Object.entries(record(value, context))
    .map(([key, child]) => [key, jsonValue(child, context, depth + 1)]));
};

const MARKERS = new Set(['required', 'httpLabel', 'httpPayload', 'httpQueryParams', 'httpResponseCode',
  'xmlFlattened', 'xmlAttribute', 'input', 'output', 'sensitive', 'sparse', 'streaming', 'idempotent', 'readonly']);
const TEXT_TRAITS = new Set(['jsonName', 'xmlName', 'httpQuery', 'httpHeader', 'httpPrefixHeaders', 'pattern', 'mediaType']);
const OMITTED = new Set(['smithy.api#documentation', 'smithy.rules#endpointBdd',
  'smithy.rules#endpointRuleSet', 'smithy.rules#endpointTests']);

const validBound = (value: unknown, integer: boolean): boolean =>
  typeof value === 'number' && Number.isFinite(value) && (!integer || (Number.isInteger(value) && value >= 0));

const bounds = (value: unknown, context: string, integer: boolean): void => {
  const limits = record(value, context);
  fields(limits, ['min', 'max'], context);
  if (Object.keys(limits).length === 0) {
    throw modelError(context, 'constraint requires min or max');
  }
  for (const bound of Object.values(limits)) {
    if (!validBound(bound, integer)) {
      throw modelError(context, 'invalid constraint bound');
    }
  }
  const min = limits['min'];
  const max = limits['max'];
  if (typeof min === 'number' && typeof max === 'number' && min > max) {
    throw modelError(context, 'minimum exceeds maximum');
  }
};

const httpTrait = (value: unknown, context: string): void => {
  const http = record(value, context);
  if (text(http['method'], context).length === 0 || !text(http['uri'], context).startsWith('/')) {
    throw modelError(context, 'invalid HTTP method or URI');
  }
  if (http['code'] !== undefined && (!Number.isInteger(http['code']) || Number(http['code']) < 100 || Number(http['code']) > 599)) {
    throw modelError(context, 'invalid HTTP status code');
  }
};

const structuredTrait = (id: string, value: unknown): void => {
  if (id === 'aws.auth#sigv4' || id === 'aws.auth#sigv4a') {
    if (text(record(value, id)['name'], id).length === 0) {
      throw modelError(id, 'empty signing name');
    }
  } else if (id === 'smithy.api#xmlNamespace') {
    const namespace = record(value, id);
    text(namespace['uri'], id);
    if (namespace['prefix'] !== undefined) {
      text(namespace['prefix'], id);
    }
  } else if (id === 'smithy.api#http') {
    httpTrait(value, id);
  } else if (id === 'smithy.api#enum') {
    for (const entry of array(value, id)) {
      text(record(entry, id)['value'], id);
    }
  } else if (id.startsWith('aws.protocols#')) {
    record(value, id);
  }
};

const constrainedTrait = (id: string, value: unknown): void => {
  if (id === 'smithy.api#range' || id === 'smithy.api#length') {
    bounds(value, id, id === 'smithy.api#length');
  } else if (id === 'smithy.api#error' && value !== 'client' && value !== 'server') {
    throw modelError(id, 'expected client or server');
  } else if (id === 'smithy.api#timestampFormat' && !['date-time', 'http-date', 'epoch-seconds'].includes(text(value, id))) {
    throw modelError(id, 'invalid timestamp format');
  } else {
    structuredTrait(id, value);
  }
};

const validateTrait = (id: string, value: unknown): void => {
  const name = id.slice('smithy.api#'.length);
  if (id.startsWith('smithy.api#') && MARKERS.has(name)) {
    fields(record(value, id), [], id);
  } else if (id.startsWith('smithy.api#') && TEXT_TRAITS.has(name)) {
    text(value, id);
  } else {
    constrainedTrait(id, value);
  }
};

export const traits = (value: unknown, context: string): ModelTraits => {
  if (value === undefined) {
    return {};
  }
  const entries = Object.entries(record(value, `${context} traits`));
  return Object.fromEntries(entries.flatMap(([id, child]): [string, ModelValue][] => {
    shapeId(id, 'trait ID');
    validateTrait(id, child);
    const data = jsonValue(child, id);
    return OMITTED.has(id) ? [] : [[id, data]];
  }));
};

/** Literal object syntax needs computed __proto__ keys to preserve their data meaning. */
export const literal = (value: ModelValue): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item: ModelValue) => literal(item)).join(', ')}]`;
  }
  if (isRecord(value)) {
    return objectLiteral(value);
  }
  return JSON.stringify(value).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
};

const objectLiteral = (value: ModelObject): string => {
  const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : Number(a > b));
  return `{ ${entries.map(([key, child]) => {
    const name = key === '__proto__' ? '["__proto__"]' : literal(key);
    return `${name}: ${literal(child)}`;
  }).join(', ')} }`;
};
