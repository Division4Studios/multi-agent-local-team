import type { IncomingMessage } from 'node:http';
import type { SigningScope } from '../../shared/aws/sigv4';
import { parseSigningScope } from '../../shared/aws/sigv4';
import { parseStrictJson } from '../../shared/aws/json';
import type { OperationShape, ServiceModel } from '../models/model';
import type { ParsedCall } from '../services/types';
import { AwsError, invalid } from '../protocol/errors';
import { validateJson } from '../protocol/json';
import { operationShape, serviceModel } from '../protocol/models';
import { parseForm, QueryDecoder } from '../protocol/query';
import { fields, record } from '../protocol/values';
import { headerValues, readBody, singleHeader } from './body';

export interface CallRoute {
  readonly target: string;
  readonly model: ServiceModel;
  readonly scope: SigningScope;
  readonly json: boolean;
}
export interface DecodedCall extends CallRoute {
  readonly shape: OperationShape;
  readonly call: ParsedCall;
}
export const isJsonRequest = (request: IncomingMessage): boolean =>
  (request.headers['content-type'] ?? '').startsWith('application/x-amz-json') || request.headers['x-amz-target'] !== undefined;
const authentication = (request: IncomingMessage, target: string): SigningScope => {
  const authorization = headerValues(request, 'authorization');
  const scope = authorization.length > 1 ? undefined : parseSigningScope(authorization[0], target);
  if (scope === undefined) { throw new AwsError('InvalidSignatureException', 'A valid SigV4 credential signing scope is required', 403); }
  return scope;
};
const inputValue = (model: ServiceModel, operation: OperationShape, value: unknown): Readonly<Record<string, unknown>> => {
  if (operation.input === undefined || operation.input.target === 'smithy.api#Unit') {
    const empty = record(value); fields(empty, []); return empty;
  }
  return record(validateJson(model, operation.input.target, value));
};
const jsonCall = (model: ServiceModel, request: IncomingMessage, body: string): { readonly call: ParsedCall; readonly shape: OperationShape } => {
  const target = singleHeader(request, 'x-amz-target');
  if (request.method !== 'POST' || model.signingName !== 'sqs' || target?.startsWith('AmazonSQS.') !== true) {
    throw invalid('Unsupported method, signing service or JSON target');
  }
  const operation = target.slice('AmazonSQS.'.length);
  const definition = operationShape(model, operation);
  let parsed: unknown;
  try { parsed = parseStrictJson(body); } catch { throw invalid('Malformed or duplicate JSON input'); }
  return { shape: definition, call: { operation, input: inputValue(model, definition, parsed) } };
};
const AUTH_PARAMETERS = new Set(['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Signature', 'X-Amz-SignedHeaders',
  'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-Security-Token']);
const queryParameters = (request: IncomingMessage, body: string, target: string): Map<string, string> => {
  const query = target.includes('?') ? target.slice(target.indexOf('?') + 1) : '';
  const entries = parseForm(query);
  if (request.method === 'POST') {
    for (const [key, value] of parseForm(body)) {
      if (entries.has(key) || AUTH_PARAMETERS.has(key)) { throw invalid('Duplicate or unsupported body authentication parameter'); }
      entries.set(key, value);
    }
  } else if (request.method !== 'GET' || body !== '') { throw invalid('Unsupported Query method or body'); }
  AUTH_PARAMETERS.forEach(key => entries.delete(key));
  return entries;
};
const pathQueue = (values: Map<string, string>, path: string, endpoint: string): void => {
  if (path === '/') { return; }
  if (!/^\/[0-9]{12}\/[a-z0-9-]+\/[A-Za-z0-9_-]{1,80}$/u.test(path)) { throw invalid('Unsupported raw request path'); }
  const url = `${endpoint}${path}`;
  if (values.has('QueueUrl') && values.get('QueueUrl') !== url) { throw invalid('Conflicting QueueUrl and request path'); }
  values.set('QueueUrl', url);
};
const queryCall = (model: ServiceModel, values: Map<string, string>): { readonly call: ParsedCall; readonly shape: OperationShape } => {
  const operation = values.get('Action');
  if (operation === undefined || values.get('Version') !== model.service.version) { throw invalid('Missing action or unsupported Query version'); }
  values.delete('Action'); values.delete('Version');
  const definition = operationShape(model, operation);
  const input = definition.input === undefined || definition.input.target === 'smithy.api#Unit' ? inputValue(model, definition, Object.fromEntries(values))
    : record(new QueryDecoder(model, values).decode(definition.input.target));
  return { shape: definition, call: { operation, input } };
};
const mediaType = (request: IncomingMessage): string | undefined => singleHeader(request, 'content-type')?.split(';')[0]?.trim().toLowerCase();
const queryPath = (model: ServiceModel, values: Map<string, string>, target: string, endpoint: string): void => {
  const path = target.split('?')[0] ?? '/';
  if (model.signingName === 'sqs') { pathQueue(values, path, endpoint); }
  else if (path !== '/') { throw invalid('Unsupported STS path'); }
};
export const routeCall = (request: IncomingMessage): CallRoute => {
  const target = request.url ?? '/';
  const scope = authentication(request, target);
  return { target, scope, model: serviceModel(scope.service), json: isJsonRequest(request) };
};
export const decodeCall = async (request: IncomingMessage, endpoint: string, route: CallRoute): Promise<DecodedCall> => {
  const { model, json, target } = route;
  const type = mediaType(request);
  const body = await readBody(request);
  if (json) {
    if (type !== 'application/x-amz-json-1.0') { throw invalid('Unsupported JSON protocol'); }
    if (target !== '/') { throw invalid('Unsupported JSON request target'); }
    return { ...route, ...jsonCall(model, request, body) };
  }
  if (request.method === 'POST' && type !== 'application/x-www-form-urlencoded') { throw invalid('Unsupported Query content type'); }
  const values = queryParameters(request, body, target);
  queryPath(model, values, target, endpoint);
  return { ...route, ...queryCall(model, values) };
};
