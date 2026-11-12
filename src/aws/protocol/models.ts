import { findShape } from '../models/lookup';
import type { ModelMember, ModelShape, ModelTraits, OperationShape, ServiceModel } from '../models/model';
import { model as sqs } from '../models/sqs';
import { model as sts } from '../models/sts';
import { invalid, unsupported } from './errors';
import { operationName } from '../services/support';

export const serviceModel = (service: string): ServiceModel => {
  if (service === 'sqs') { return sqs; }
  if (service === 'sts') { return sts; }
  throw unsupported(service, 'service');
};
export const shape = (model: ServiceModel, id: string): ModelShape => {
  const found = findShape(model, id);
  if (found === undefined) { throw invalid('Unknown model binding'); }
  return found;
};
export const operationShape = (model: ServiceModel, operation: string): OperationShape => {
  const reference = model.service.operations.find(item => operationName(item.target) === operation);
  const found = reference === undefined ? undefined : findShape(model, reference.target);
  if (found?.type !== 'operation') { throw unsupported(model.signingName, operation); }
  return found;
};
export const wireName = (member: ModelMember, fallback: string): string => {
  const name = member.traits['smithy.api#xmlName'];
  return typeof name === 'string' ? name : fallback;
};
export const flattened = (traits: ModelTraits): boolean => Object.hasOwn(traits, 'smithy.api#xmlFlattened');
export const required = (member: ModelMember): boolean => Object.hasOwn(member.traits, 'smithy.api#required');
export const namespace = (model: ServiceModel): string => model.signingName === 'sqs'
  ? 'http://queue.amazonaws.com/doc/2012-11-05/' : 'https://sts.amazonaws.com/doc/2011-06-15/';
