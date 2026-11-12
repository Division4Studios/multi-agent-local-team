import type { AccountRegion, OperationStatus } from '../../shared/aws/types';
export type { AccountRegion } from '../../shared/aws/types';
export interface CallContext extends AccountRegion {
  readonly accessKeyId: string;
  readonly principalArn: string;
  readonly traceId: string;
  readonly emit: (event: Readonly<Record<string, unknown>>) => void;
}
export interface ParsedCall { readonly operation: string; readonly input: Readonly<Record<string, unknown>> }
export interface OperationSupport { readonly status: OperationStatus; readonly limitations: readonly string[] }
export interface StateDocument {
  readonly formatVersion: 1;
  readonly service: string;
  readonly scope: AccountRegion;
  readonly data: unknown;
}
export interface ServiceBackend {
  readonly service: string;
  readonly operations: ReadonlyMap<string, OperationSupport>;
  handle(call: ParsedCall, context: CallContext): Promise<Readonly<Record<string, unknown>>>;
  exportState(scope: AccountRegion): StateDocument;
  importState(scope: AccountRegion, document: unknown): void;
  reset(scope: AccountRegion | 'all'): void;
}
