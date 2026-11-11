import type { AggregateShape, ModelMember, ModelShape, ResourceShape, ServiceShape, ShapeReference, SimpleKind } from '../src/aws/models/model.ts';
import { array, fields, identifier, modelError, record, shapeId, text, traits } from './aws-model-values.mts';

const SIMPLE_KINDS: ReadonlySet<string> = new Set([
  'blob', 'boolean', 'document', 'string', 'byte', 'short', 'integer', 'long',
  'float', 'double', 'bigInteger', 'bigDecimal', 'timestamp',
]);
const isSimple = (value: string): value is SimpleKind => SIMPLE_KINDS.has(value);
const BASE_FIELDS = ['type', 'traits'];
export const LIFECYCLE = ['create', 'put', 'read', 'update', 'delete', 'list'];

const reference = (value: unknown, context: string): ShapeReference => {
  const data = record(value, context);
  fields(data, ['target'], context);
  return { target: shapeId(data['target'], context) };
};

const references = (value: unknown, context: string): readonly ShapeReference[] => {
  if (value === undefined) {
    return [];
  }
  const result = array(value, context).map(item => reference(item, context));
  if (new Set(result.map(item => item.target)).size !== result.length) {
    throw modelError(context, 'duplicate shape reference');
  }
  return result;
};

const optionalReference = (data: Record<string, unknown>, key: string): Readonly<Record<string, ShapeReference>> =>
  data[key] === undefined ? {} : { [key]: reference(data[key], key) };

const member = (value: unknown, context: string): ModelMember => {
  const data = record(value, context);
  fields(data, ['target', 'traits'], context);
  return { target: shapeId(data['target'], context), traits: traits(data['traits'], context) };
};

const namedEntries = (value: unknown, context: string): [string, unknown][] => {
  const entries = Object.entries(record(value, context));
  const names = new Set<string>();
  for (const [name] of entries) {
    identifier(name, context);
    if (names.has(name.toLowerCase())) {
      throw modelError(context, `case-insensitive duplicate member ${name}`);
    }
    names.add(name.toLowerCase());
  }
  return entries;
};

const validEnumValue = (value: unknown, kind: 'enum' | 'intEnum'): value is string | number =>
  kind === 'enum' ? typeof value === 'string'
    : typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;

const enumMembers = (members: Readonly<Record<string, ModelMember>>, kind: 'enum' | 'intEnum'): void => {
  const values = new Set<string | number>();
  for (const [name, entry] of Object.entries(members)) {
    const value = entry.traits['smithy.api#enumValue'];
    if (!validEnumValue(value, kind) || entry.target !== 'smithy.api#Unit') {
      throw modelError(name, `invalid ${kind} member target or enumValue`);
    }
    if (values.has(value)) {
      throw modelError(name, 'duplicate enumValue');
    }
    values.add(value);
  }
};

const aggregate = (data: Record<string, unknown>, kind: AggregateShape['type']): AggregateShape => {
  fields(data, [...BASE_FIELDS, 'members'], kind);
  const raw = data['members'] === undefined && kind === 'structure' ? {} : data['members'];
  const members = Object.fromEntries(namedEntries(raw, `${kind} members`).map(([name, entry]) => [name, member(entry, name)]));
  if (Object.keys(members).length === 0 && kind !== 'structure') {
    throw modelError(kind, 'at least one member is required');
  }
  if (kind === 'enum' || kind === 'intEnum') {
    enumMembers(members, kind);
  }
  return { type: kind, members, traits: traits(data['traits'], kind) };
};

const service = (data: Record<string, unknown>): ServiceShape => {
  fields(data, [...BASE_FIELDS, 'version', 'operations', 'resources', 'errors', 'rename'], 'service');
  const rename = Object.fromEntries(Object.entries(record(data['rename'] === undefined ? {} : data['rename'], 'service rename'))
    .map(([id, name]) => [shapeId(id, 'rename'), identifier(name, 'rename')]));
  return {
    type: 'service',
    ...(data['version'] === undefined ? {} : { version: text(data['version'], 'service version') }),
    operations: references(data['operations'], 'service operations'),
    resources: references(data['resources'], 'service resources'),
    errors: references(data['errors'], 'service errors'), rename,
    traits: traits(data['traits'], 'service'),
  };
};

const referenceMap = (value: unknown, context: string): Readonly<Record<string, ShapeReference>> =>
  Object.fromEntries(namedEntries(value === undefined ? {} : value, context).map(([name, entry]) => [name, reference(entry, context)]));

const resource = (data: Record<string, unknown>): ResourceShape => {
  fields(data, [...BASE_FIELDS, ...LIFECYCLE, 'identifiers', 'properties', 'operations', 'collectionOperations', 'resources'], 'resource');
  return {
    type: 'resource', traits: traits(data['traits'], 'resource'),
    identifiers: referenceMap(data['identifiers'], 'resource identifiers'),
    properties: referenceMap(data['properties'], 'resource properties'),
    ...Object.fromEntries(LIFECYCLE.flatMap(key => Object.entries(optionalReference(data, key)))),
    operations: references(data['operations'], 'resource operations'),
    collectionOperations: references(data['collectionOperations'], 'resource collectionOperations'),
    resources: references(data['resources'], 'resource resources'),
  };
};

const container = (data: Record<string, unknown>, kind: 'list' | 'map'): ModelShape => {
  const shapeTraits = traits(data['traits'], kind);
  if (kind === 'list') {
    fields(data, [...BASE_FIELDS, 'member'], kind);
    return { type: kind, member: member(data['member'], 'list member'), traits: shapeTraits };
  }
  fields(data, [...BASE_FIELDS, 'key', 'value'], kind);
  return { type: kind, key: member(data['key'], 'map key'), value: member(data['value'], 'map value'), traits: shapeTraits };
};

const dataShape = (data: Record<string, unknown>, kind: string, id: string): ModelShape => {
  if (kind === 'structure' || kind === 'union' || kind === 'enum' || kind === 'intEnum') {
    return aggregate(data, kind);
  }
  if (kind === 'list' || kind === 'map') {
    return container(data, kind);
  }
  throw modelError(id, `unsupported shape type ${kind}; provide a resolved Smithy 2 AST`);
};

export const parseShape = (value: unknown, id: string): ModelShape => {
  const data = record(value, id);
  const kind = text(data['type'], `${id} shape type`);
  if (isSimple(kind)) {
    fields(data, BASE_FIELDS, id);
    return { type: kind, traits: traits(data['traits'], id) };
  }
  if (kind === 'service') {
    return service(data);
  }
  if (kind === 'resource') {
    return resource(data);
  }
  if (kind === 'operation') {
    fields(data, [...BASE_FIELDS, 'input', 'output', 'errors'], id);
    return { type: kind, ...optionalReference(data, 'input'), ...optionalReference(data, 'output'),
      errors: references(data['errors'], `${id} errors`), traits: traits(data['traits'], id) };
  }
  return dataShape(data, kind, id);
};

export const preludeShapes = (): ReadonlyMap<string, ModelShape> => {
  const entries: [string, ModelShape][] = [];
  for (const kind of SIMPLE_KINDS) {
    if (isSimple(kind)) {
      const name = kind.charAt(0).toUpperCase() + kind.slice(1);
      entries.push([`smithy.api#${name}`, { type: kind, traits: {} }]);
    }
  }
  entries.push(['smithy.api#Unit', { type: 'structure', members: {}, traits: {} }]);
  return new Map(entries);
};
