import { resolve } from 'node:path';
import { fileArea } from '../shared/aws/files';
import type { AccountRegion } from '../shared/aws/types';
import { coverageReport } from './coverage/report';
import { adminHandler } from './http/admin';
import { Gateway } from './http/gateway';
import { Listener } from './http/listener';
import { validateOptions } from './options';
import type { AwsServerOptions } from './options';
import { createSqsBackend } from './services/sqs/backend';
import type { SqsBackend } from './services/sqs/backend';
import { createStsBackend } from './services/sts/backend';
import { diskEnvelope, importDocuments, parseDocuments } from './state/documents';
import { acquireLock } from './state/lock';
import { Persistence } from './state/persistence';
export type { AwsServerOptions } from './options';

export interface RunningAws { readonly gatewayUrl: string; readonly adminUrl: string; close(): Promise<void> }
interface Lifetime {
  readonly gateway: Listener;
  readonly admin: Listener;
  release?: () => Promise<void>;
  persistence?: Persistence;
  sqs?: SqsBackend;
}
const shutdown = async (lifetime: Lifetime): Promise<void> => {
  lifetime.sqs?.close();
  const failures: unknown[] = [];
  const attempt = async (action: () => Promise<void>): Promise<void> => {
    try { await action(); } catch (error) { failures.push(error); }
  };
  await Promise.all([
    attempt(async () => { await lifetime.gateway.close(); }),
    attempt(async () => { await lifetime.admin.close(); }),
  ]);
  await attempt(async () => { await lifetime.persistence?.close(); });
  await attempt(async () => { await lifetime.release?.(); });
  if (failures.length !== 0) { throw new AggregateError(failures, 'AWS shutdown cleanup failed'); }
};
export const startAwsServer = async (options: AwsServerOptions): Promise<RunningAws> => {
  const valid = validateOptions(options);
  const lifetime: Lifetime = { gateway: new Listener(), admin: new Listener() };
  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => { closing ??= shutdown(lifetime); await closing; };
  try {
    const area = await fileArea(valid.stateDirectory, true);
    lifetime.release = await acquireLock(area);
    const documents = parseDocuments(await area.read('state.json'));
    const gatewayUrl = await lifetime.gateway.listen(valid.host, valid.port);
    const endpoint = valid.endpoint ?? gatewayUrl;
    const sqs = createSqsBackend({ endpoint });
    lifetime.sqs = sqs;
    const backends = [sqs, createStsBackend()];
    importDocuments(backends, documents);
    const coverage = await coverageReport(backends, resolve(__dirname, '..'));
    // Persist derived coverage separately, after all service documents validated.
    const adminUrl = await lifetime.admin.listen(valid.adminHost, valid.adminPort);
    await area.write('coverage.json', coverage);
    const persistence = new Persistence(area, () => diskEnvelope(sqs.scopes().map(scope => sqs.exportState(scope))), coverage);
    lifetime.persistence = persistence;
    const gateway = new Gateway(endpoint, backends, () => { persistence.dirty(); });
    const reset = (scope: AccountRegion | 'all'): void => { backends.forEach(backend => { backend.reset(scope); }); persistence.dirty(); };
    lifetime.gateway.setHandler(async (request, response) => { await gateway.handle(request, response); });
    lifetime.admin.setHandler(adminHandler(valid.adminToken, { gateway, coverage, resources: () => sqs.resources(),
      reset, save: async () => { await persistence.flush(); }, close }));
    return { gatewayUrl, adminUrl, close };
  } catch (error) {
    await close();
    throw error;
  }
};
