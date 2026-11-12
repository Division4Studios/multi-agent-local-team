import type { ModelShape, ServiceModel } from '../models/model';
import { invalid } from './errors';
import { shape, required } from './models';
import { primitive } from './primitives';
import { list, record } from './values';

export const validateJson = (model: ServiceModel, target: string, value: unknown, depth = 0): unknown => {
  if (depth > 64) { throw invalid('Input nesting exceeds limit'); }
  const definition = shape(model, target);
  if (definition.type === 'structure') { return structure(model, definition, value, depth); }
  if (definition.type === 'list') { return list(value).map(item => validateJson(model, definition.member.target, item, depth + 1)); }
  if (definition.type === 'map') {
    return Object.fromEntries(Object.entries(record(value)).map(([key, item]) => [
      primitive(shape(model, definition.key.target), key), validateJson(model, definition.value.target, item, depth + 1),
    ]));
  }
  return primitive(definition, value);
};
interface StructureInput { readonly members: Extract<ModelShape, { type: 'structure' | 'union' | 'enum' | 'intEnum' }>['members'] }
const structure = (model: ServiceModel, definition: StructureInput, value: unknown, depth: number): Readonly<Record<string, unknown>> => {
  const input = record(value);
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(definition.members, key)) { throw invalid('Unknown input member'); }
  }
  const output = new Map<string, unknown>();
  for (const [key, member] of Object.entries(definition.members)) {
    if (!Object.hasOwn(input, key)) {
      if (required(member)) { throw invalid(`Missing required member ${key}`); }
      continue;
    }
    output.set(key, validateJson(model, member.target, input[key], depth + 1));
  }
  return Object.fromEntries(output);
};
