/** Runtime type guards for untrusted JSON. Shared by the extension and the reviewer service. */

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isString = (value: unknown): value is string => typeof value === 'string';

export const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Parses every item with `parse`; returns undefined if the value is not an array or any item fails. */
export const parseArray = <T>(value: unknown, parse: (item: unknown) => T | undefined): T[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: readonly unknown[] = value;
  const result: T[] = [];
  for (const item of items) {
    const parsed = parse(item);
    if (parsed === undefined) {
      return undefined;
    }
    result.push(parsed);
  }
  return result;
};

/** Reads string fields from a record; returns undefined if any is missing or not a string. */
export const readStrings = <K extends string>(
  value: Readonly<Record<string, unknown>>,
  keys: readonly K[],
): Record<K, string> | undefined => {
  const result: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const field = value[key];
    if (!isString(field)) {
      return undefined;
    }
    result[key] = field;
  }
  return isComplete(result, keys) ? result : undefined;
};

const isComplete = <K extends string>(
  value: Partial<Record<K, string>>,
  keys: readonly K[],
): value is Record<K, string> => keys.every((key) => value[key] !== undefined);
