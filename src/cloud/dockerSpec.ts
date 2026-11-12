import { stat } from 'node:fs/promises';
import { containerIdentity } from '../backend/dockerBackend';
import { isRecord } from '../shared/guards';
import type { AwsBackendStart } from './backend';
import { backendEndpoint } from './startOptions';

export interface SocketIdentity { readonly source: string; readonly user: string; readonly groups: readonly string[] }
const nativeIdentity = (engine: unknown): ReturnType<typeof containerIdentity> => containerIdentity({
  platform: process.platform, uid: process.getuid?.(), gid: process.getgid?.(), groups: process.getgroups?.() ?? [], engine,
});
export const socketIdentity = async (socketPath: string, engine: unknown): Promise<SocketIdentity> => {
  if (!isRecord(engine) || engine['OSType'] !== 'linux' || typeof engine['OperatingSystem'] !== 'string') {
    throw new Error('Local AWS requires a Linux Docker engine.');
  }
  if (engine['OperatingSystem'].includes('Docker Desktop')) {
    // Docker Desktop's daemon socket is inside its Linux VM, owned by root:root.
    return { source: '/var/run/docker.sock', user: 'node', groups: ['0'] };
  }
  if (process.platform !== 'linux') { throw new Error('Local AWS cannot resolve this Docker socket mount.'); }
  const socket = await stat(socketPath);
  if (!socket.isSocket()) { throw new Error('Local AWS requires a Unix Docker socket.'); }
  const identity = nativeIdentity(engine);
  return { source: socketPath, user: identity.user, groups: [...new Set([...identity.groups, String(socket.gid)])] };
};

export const awsContainerSpec = (image: string, options: AwsBackendStart, identity: SocketIdentity, labels: Readonly<Record<string, string>>): Record<string, unknown> => ({
  Image: image, User: identity.user, Cmd: ['node', 'aws/main.js'], Labels: labels,
  Env: ['MALT_AWS_HOST=0.0.0.0', 'MALT_AWS_ADMIN_HOST=0.0.0.0',
    `MALT_AWS_PORT=${String(options.port)}`, `MALT_AWS_ADMIN_PORT=${String(options.adminPort)}`,
    `MALT_AWS_ADMIN_TOKEN=${options.token}`, 'MALT_AWS_STATE_DIRECTORY=/state', `MALT_AWS_ENDPOINT=${backendEndpoint(options).gatewayUrl}`],
  ExposedPorts: { [`${String(options.port)}/tcp`]: {}, [`${String(options.adminPort)}/tcp`]: {} },
  HostConfig: {
    Mounts: [{ Type: 'bind', Source: options.stateDirectory, Target: '/state', ReadOnly: false },
      { Type: 'bind', Source: identity.source, Target: '/var/run/docker.sock', ReadOnly: false }],
    GroupAdd: identity.groups,
    PortBindings: { [`${String(options.port)}/tcp`]: [{ HostIp: options.bindAddress, HostPort: String(options.port) }],
      [`${String(options.adminPort)}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(options.adminPort) }] },
    ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'],
    Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024, PidsLimit: 128,
    Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=64m,mode=1777' },
  },
});
