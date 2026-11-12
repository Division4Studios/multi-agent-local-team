import { model } from '../../models/sts';
import { unsupported } from '../../protocol/errors';
import { fields, record } from '../../protocol/values';
import { stateData, stateDocument } from '../state';
import { supportMap } from '../support';
import type { ServiceBackend } from '../types';

export const createStsBackend = (): ServiceBackend => ({
  service: 'sts',
  operations: supportMap(model, { GetCallerIdentity: ['Only the local root identity is supported.'] }),
  async handle(call, context): Promise<Readonly<Record<string, unknown>>> {
    if (call.operation !== 'GetCallerIdentity') { throw unsupported('sts', call.operation); }
    fields(call.input, []);
    return await Promise.resolve({ Account: context.account, Arn: context.principalArn, UserId: context.account });
  },
  exportState: scope => stateDocument('sts', scope, {}),
  importState: (scope, document): void => { fields(record(stateData(document, 'sts', scope)), []); },
  reset: (): void => { /* STS has no mutable state in this milestone. */ },
});
