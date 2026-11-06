/**
 * Codex enforces its output schema in OpenAI's strict mode: every object lists all its properties as required and
 * allows no others, so a property MALT treats as optional becomes nullable instead. Only the structural keywords are
 * kept (strict mode rejects some constraints); MALT's own parsers still check every answer, limits included.
 */
import { isRecord } from '../shared/guards';

type Schema = Readonly<Record<string, unknown>>;

const KEPT = ['type', 'enum', 'const', 'description'];

const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });

const strictProperties = (properties: Schema, required: readonly unknown[]): Record<string, unknown> => {
  const strict: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    const property = toStrictSchema(isRecord(value) ? value : {});
    strict[key] = required.includes(key) ? property : nullable(property);
  }
  return strict;
};

/** The strict-mode form of a JSON Schema (the subset MALT's answer schemas use). */
export const toStrictSchema = (schema: Schema): Schema => {
  const strict: Record<string, unknown> = {};
  for (const key of KEPT) {
    if (Object.hasOwn(schema, key)) {
      strict[key] = schema[key];
    }
  }
  const { properties, required, items, anyOf } = schema;
  if (isRecord(properties)) {
    strict['properties'] = strictProperties(properties, Array.isArray(required) ? required : []);
    strict['required'] = Object.keys(properties);
    strict['additionalProperties'] = false;
  }
  if (isRecord(items)) {
    strict['items'] = toStrictSchema(items);
  }
  if (Array.isArray(anyOf)) {
    strict['anyOf'] = anyOf.map((option: unknown) => toStrictSchema(isRecord(option) ? option : {}));
  }
  return strict;
};

/** An answer to a strict schema, back in MALT's form: the nulls that stand for "not given" are removed. */
export const stripNulls = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(stripNulls);
  }
  if (!isRecord(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null) {
      result[key] = stripNulls(entry);
    }
  }
  return result;
};
