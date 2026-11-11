/** Data-only Smithy contract shared by the generator and generic runtime codecs. */
export type ModelValue = null | boolean | number | string | readonly ModelValue[] | ModelObject;
export interface ModelObject { readonly [key: string]: ModelValue }
export type ModelTraits = Readonly<Record<string, ModelValue>>;

export interface ShapeReference { readonly target: string }
export interface ModelMember extends ShapeReference { readonly traits: ModelTraits }
interface ShapeBase { readonly traits: ModelTraits }

export type SimpleKind = 'blob' | 'boolean' | 'document' | 'string' | 'byte' | 'short'
  | 'integer' | 'long' | 'float' | 'double' | 'bigInteger' | 'bigDecimal' | 'timestamp';
export interface SimpleShape extends ShapeBase { readonly type: SimpleKind }
export interface AggregateShape extends ShapeBase {
  readonly type: 'structure' | 'union' | 'enum' | 'intEnum';
  readonly members: Readonly<Record<string, ModelMember>>;
}
export interface ListShape extends ShapeBase {
  readonly type: 'list';
  readonly member: ModelMember;
}
export interface MapShape extends ShapeBase {
  readonly type: 'map';
  readonly key: ModelMember;
  readonly value: ModelMember;
}
export interface OperationShape extends ShapeBase {
  readonly type: 'operation';
  readonly input?: ShapeReference;
  readonly output?: ShapeReference;
  readonly errors: readonly ShapeReference[];
}
export interface ServiceShape extends ShapeBase {
  readonly type: 'service';
  readonly version?: string;
  readonly operations: readonly ShapeReference[];
  readonly resources: readonly ShapeReference[];
  readonly errors: readonly ShapeReference[];
  readonly rename: Readonly<Record<string, string>>;
}
export interface ResourceShape extends ShapeBase {
  readonly type: 'resource';
  readonly identifiers: Readonly<Record<string, ShapeReference>>;
  readonly properties: Readonly<Record<string, ShapeReference>>;
  readonly create?: ShapeReference;
  readonly put?: ShapeReference;
  readonly read?: ShapeReference;
  readonly update?: ShapeReference;
  readonly delete?: ShapeReference;
  readonly list?: ShapeReference;
  readonly operations: readonly ShapeReference[];
  readonly collectionOperations: readonly ShapeReference[];
  readonly resources: readonly ShapeReference[];
}
export type ModelShape = SimpleShape | AggregateShape | ListShape | MapShape | OperationShape | ServiceShape | ResourceShape;
export type ShapeTable = Readonly<Record<string, ModelShape>>;
export interface ShapeCatalog {
  readonly tables: readonly ShapeTable[];
  readonly children: readonly ShapeCatalog[];
}
export interface ServiceModel {
  readonly smithy: string;
  readonly serviceId: string;
  readonly signingName: string;
  readonly service: ServiceShape;
  /** Sorted, non-overlapping tables, including explicitly referenced prelude shapes. */
  readonly shapes: ShapeCatalog;
}
