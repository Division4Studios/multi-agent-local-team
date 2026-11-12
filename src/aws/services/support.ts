import type { ServiceModel } from '../models/model';
import type { OperationSupport } from './types';
export const operationName = (id: string): string => id.slice(id.indexOf('#') + 1);
export const supportMap = (model: ServiceModel, implemented: Readonly<Record<string, readonly string[]>>): ReadonlyMap<string, OperationSupport> =>
  new Map(model.service.operations.map(({ target }) => {
    const name = operationName(target);
    const limits = Object.hasOwn(implemented, name) ? implemented[name] : undefined;
    const support: OperationSupport = limits === undefined
      ? { status: 'unsupported', limitations: ['Operation is not implemented.'] }
      : { status: 'partial', limitations: ['Default root identity; signature syntax only, no secret verification or IAM policy evaluation.', ...limits] };
    return [name, support];
  }));
