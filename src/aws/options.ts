import { isAbsolute } from 'node:path';
import { httpOrigin } from '../shared/aws/validation';

export interface AwsServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly adminPort?: number;
  readonly adminHost?: '127.0.0.1' | '0.0.0.0';
  readonly endpoint?: string;
  readonly adminToken: string;
  readonly stateDirectory: string;
}
export interface ValidOptions extends AwsServerOptions {
  readonly host: string;
  readonly port: number;
  readonly adminPort: number;
  readonly adminHost: '127.0.0.1' | '0.0.0.0';
}
const port = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) { throw new Error('Invalid AWS listener port'); }
  return value;
};
const validateOwnership = (options: AwsServerOptions): void => {
  if (typeof options.adminToken !== 'string' || options.adminToken.length < 32 || /[\p{Cc}]/u.test(options.adminToken)) { throw new Error('Invalid AWS admin token'); }
  if (typeof options.stateDirectory !== 'string' || !isAbsolute(options.stateDirectory)) { throw new Error('AWS state directory must be absolute'); }
};
const adminAddress = (value: unknown): '127.0.0.1' | '0.0.0.0' => {
  if (value === '127.0.0.1' || value === '0.0.0.0') { return value; }
  throw new Error('Invalid AWS admin host');
};
export const validateOptions = (options: AwsServerOptions): ValidOptions => {
  validateOwnership(options);
  const host = options.host ?? '127.0.0.1';
  const adminHost = adminAddress(options.adminHost ?? '127.0.0.1');
  if (typeof host !== 'string' || host.length === 0 || /[\s/@?#]/u.test(host)) { throw new Error('Invalid AWS listener host'); }
  return { ...options, host, adminHost, port: port(options.port ?? 4566), adminPort: port(options.adminPort ?? 0),
    ...(options.endpoint === undefined ? {} : { endpoint: httpOrigin(options.endpoint) }) };
};
