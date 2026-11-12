import { startAwsServer } from './server';
import type { AwsServerOptions } from './server';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') { throw new Error(`Missing ${name}`); }
  return value;
};
const port = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (value === undefined) { return fallback; }
  if (!/^[0-9]+$/u.test(value)) { throw new Error(`Invalid ${name}`); }
  return Number(value);
};
const environment = (): AwsServerOptions => {
  const adminHost = process.env['MALT_AWS_ADMIN_HOST'] ?? '127.0.0.1';
  if (adminHost !== '127.0.0.1' && adminHost !== '0.0.0.0') { throw new Error('Invalid MALT_AWS_ADMIN_HOST'); }
  const endpoint = process.env['MALT_AWS_ENDPOINT'];
  return { host: process.env['MALT_AWS_HOST'] ?? '127.0.0.1', port: port('MALT_AWS_PORT', 4566),
    adminHost, adminPort: port('MALT_AWS_ADMIN_PORT', 0), adminToken: required('MALT_AWS_ADMIN_TOKEN'),
    stateDirectory: required('MALT_AWS_STATE_DIRECTORY'), ...(endpoint === undefined ? {} : { endpoint }) };
};
const main = async (): Promise<void> => {
  const running = await startAwsServer(environment());
  const stop = (): void => {
    void running.close().catch(() => { process.exitCode = 1; process.stderr.write('AWS shutdown failed.\n'); });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.write(`AWS gateway ${running.gatewayUrl}; admin ${running.adminUrl}\n`);
};
void main().catch(() => { process.exitCode = 1; process.stderr.write('AWS startup failed; check configuration and state ownership.\n'); });
