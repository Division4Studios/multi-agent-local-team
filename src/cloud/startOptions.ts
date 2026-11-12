import { createServer, isIP } from 'node:net';
import { validRegion } from '../shared/aws/validation';
import type { AwsStartRequest, AwsManagerDependencies } from './manager';
import type { AwsBackend, AwsBackendStart, AwsEndpoint } from './backend';
import { validateAdminEndpoint } from './adminTransport';
import { containedAbsoluteState } from './containment';

export const validPort = (value: number): boolean => Number.isInteger(value) && value > 0 && value <= 65535;
export const validateStart = (request: AwsStartRequest): void => {
  if (!request.trusted || request.workspaceRoot === '') { throw new Error('A trusted workspace is required for Local AWS.'); }
  if (!validPort(request.port) || isIP(request.bindAddress) === 0 || !validRegion(request.region)
    || !['host', 'docker', 'auto'].includes(request.backend)) { throw new Error('Invalid Local AWS settings.'); }
};
export const isLoopback = (address: string): boolean => address === '::1' || (isIP(address) === 4 && address.startsWith('127.'));

const availablePort = async (): Promise<number> => {
  const server = createServer();
  try {
    return await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') { reject(new Error('Local AWS admin port unavailable.')); }
        else { resolve(address.port); }
      });
    });
  } finally {
    if (server.listening) { await new Promise<void>((resolve, reject) => { server.close(error => { if (error === undefined) { resolve(); } else { reject(error); } }); }); }
  }
};
export const allocateAdminPort = async (gateway: number): Promise<number> => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await availablePort();
    if (port !== gateway) { return port; }
  }
  throw new Error('Local AWS admin port unavailable.');
};

export const chooseBackend = async (deps: AwsManagerDependencies, request: AwsStartRequest, check: () => void): Promise<AwsBackend> => {
  if (!isLoopback(request.bindAddress)) {
    const accepted = await deps.confirmExternalBind(request.bindAddress);
    check();
    if (!accepted) { throw new Error('Local AWS external binding was declined.'); }
  }
  if (request.backend === 'host') { return deps.host; }
  const available = await deps.docker.isAvailable();
  check();
  if (available && await socketAllowed(deps, check)) { return deps.docker; }
  if (request.backend === 'docker') { throw new Error('Local AWS needs available Docker and socket consent.'); }
  const fallback = await deps.confirmHostFallback();
  check();
  if (!fallback) { throw new Error('Local AWS host fallback was declined.'); }
  return deps.host;
};
const socketAllowed = async (deps: AwsManagerDependencies, check: () => void): Promise<boolean> => {
  if (deps.hasSocketConsent()) { return true; }
  const accepted = await deps.requestSocketConsent();
  check();
  if (accepted) { await deps.storeSocketConsent(); check(); }
  return accepted;
};

export const backendEndpoint = (options: AwsBackendStart): AwsEndpoint => {
  const address = options.bindAddress === '0.0.0.0' ? '127.0.0.1' : options.bindAddress;
  const host = address === '::' ? '[::1]' : isIP(address) === 6 ? `[${address}]` : address;
  return { gatewayUrl: `http://${host}:${String(options.port)}`, adminUrl: `http://127.0.0.1:${String(options.adminPort)}` };
};
export const validateBackendStart = async (options: AwsBackendStart): Promise<void> => {
  if (!validPort(options.port) || !validPort(options.adminPort) || options.port === options.adminPort || isIP(options.bindAddress) === 0) {
    throw new Error('Invalid Local AWS backend ports or binding.');
  }
  validateAdminEndpoint({ url: backendEndpoint(options).adminUrl, token: options.token });
  await containedAbsoluteState(options.workspaceRoot, options.stateDirectory);
};
