import type { ModelShape, ResourceShape, ServiceShape, ShapeReference } from '../src/aws/models/model.ts';
import { modelError, record, shapeId, text } from './aws-model-values.mts';
import { parseShape, preludeShapes } from './aws-model-shapes.mts';

interface Edge extends ShapeReference { readonly kind: 'data' | 'string' | 'structure' | 'error' | 'operation' | 'resource' }
const edges = (refs: readonly ShapeReference[], kind: Edge['kind']): Edge[] => refs.map(ref => ({ ...ref, kind }));

const resourceEdges = (shape: ResourceShape): Edge[] => [
  ...edges(Object.values(shape.identifiers), 'string'), ...edges(Object.values(shape.properties), 'data'),
  ...edges([shape.create, shape.put, shape.read, shape.update, shape.delete, shape.list]
    .filter(ref => ref !== undefined), 'operation'),
  ...edges(shape.operations, 'operation'), ...edges(shape.collectionOperations, 'operation'),
  ...edges(shape.resources, 'resource'),
];

const shapeEdges = (shape: ModelShape): Edge[] => {
  if (shape.type === 'operation') {
    return [...edges([shape.input, shape.output].filter(ref => ref !== undefined), 'structure'), ...edges(shape.errors, 'error')];
  }
  if (shape.type === 'service') {
    return [...edges(shape.operations, 'operation'), ...edges(shape.resources, 'resource'), ...edges(shape.errors, 'error')];
  }
  if (shape.type === 'resource') {
    return resourceEdges(shape);
  }
  return dataEdges(shape);
};

const dataEdges = (shape: ModelShape): Edge[] => {
  if (shape.type === 'structure' || shape.type === 'union' || shape.type === 'enum' || shape.type === 'intEnum') {
    return edges(Object.values(shape.members), 'data');
  }
  if (shape.type === 'list') {
    return edges([shape.member], 'data');
  }
  if (shape.type === 'map') {
    return [...edges([shape.key], 'string'), ...edges([shape.value], 'data')];
  }
  return [];
};

const validTarget = (edge: Edge, target: ModelShape): boolean => {
  switch (edge.kind) {
    case 'data': return !['service', 'operation', 'resource'].includes(target.type);
    case 'string': return target.type === 'string' || target.type === 'enum';
    case 'error': return target.type === 'structure' && ['client', 'server'].some(kind => target.traits['smithy.api#error'] === kind);
    case 'structure': case 'operation': case 'resource': return target.type === edge.kind;
  }
};

const validateEdges = (id: string, shape: ModelShape, all: ReadonlyMap<string, ModelShape>): void => {
  for (const edge of shapeEdges(shape)) {
    const target = all.get(edge.target);
    if (target === undefined || !validTarget(edge, target)) {
      throw modelError(id, `invalid ${edge.kind} reference target ${edge.target}`);
    }
  }
};

const selectedService = (shapes: ReadonlyMap<string, ModelShape>, signingName: string): [string, ServiceShape] => {
  const matches: [string, ServiceShape][] = [];
  for (const [id, shape] of shapes) {
    if (shape.type !== 'service') {
      continue;
    }
    const signing = shape.traits['aws.auth#sigv4'];
    if (signing !== undefined && record(signing, `${id} signing trait`)['name'] === signingName) {
      matches.push([id, shape]);
    }
  }
  const match = matches[0];
  if (signingName.length === 0 || matches.length !== 1 || match === undefined) {
    throw modelError('service selection', `expected exactly one service with signing name ${JSON.stringify(signingName)}`);
  }
  return match;
};

const closure = (id: string, all: ReadonlyMap<string, ModelShape>): ReadonlyMap<string, ModelShape> => {
  const found = new Map<string, ModelShape>();
  const pending = [id];
  for (const next of pending) {
    if (found.has(next)) {
      continue;
    }
    const shape = all.get(next);
    if (shape === undefined) {
      throw modelError(next, 'unresolved shape reference');
    }
    found.set(next, shape);
    pending.push(...shapeEdges(shape).map(edge => edge.target));
  }
  return new Map([...found].sort(([a], [b]) => a < b ? -1 : Number(a > b)));
};

export interface ValidatedModel {
  readonly smithy: string;
  readonly serviceId: string;
  readonly service: ServiceShape;
  readonly shapes: ReadonlyMap<string, ModelShape>;
}

export const validateModel = (input: unknown, signingName: string): ValidatedModel => {
  const root = record(input, 'root');
  const smithy = text(root['smithy'], 'version');
  if (smithy !== '2' && smithy !== '2.0') {
    throw modelError('version', 'only Smithy 2 and 2.0 are supported');
  }
  const shapes = new Map(Object.entries(record(root['shapes'], 'shapes'))
    .map(([id, value]): [string, ModelShape] => [shapeId(id, 'shape key'), parseShape(value, id)]));
  const all = new Map([...preludeShapes(), ...shapes]);
  for (const [id, shape] of shapes) {
    validateEdges(id, shape, all);
  }
  const [serviceId, service] = selectedService(shapes, signingName);
  const reachable = closure(serviceId, all);
  for (const id of Object.keys(service.rename)) {
    if (!reachable.has(id)) {
      throw modelError('service rename', `shape ${id} is outside service closure`);
    }
  }
  return { smithy, serviceId, service, shapes: reachable };
};
