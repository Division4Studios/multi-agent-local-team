/**
 * Runs the reviewer in a hardened container: workspace mounted read-only, read-only root filesystem,
 * all capabilities dropped, no privilege escalation, port bound to 127.0.0.1 only.
 * The image is built locally from files shipped inside the extension; its tag is a hash of the build context,
 * so a changed reviewer is rebuilt automatically.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { isRecord } from '../shared/guards';
import type { LogSink, ReviewerBackend, StartOptions } from './backend';
import { DockerClient, dockerErrorMessage } from './dockerApi';
import { createTar } from './tar';
import type { TarEntry } from './tar';

const CONTAINER_PORT = 8787;

const listJs = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js'))
    .map((entry) => join(entry.parentPath, entry.name));
};

const buildContext = async (extensionRoot: string): Promise<Buffer> => {
  const entries: TarEntry[] = [{ name: 'Dockerfile', data: await readFile(join(extensionRoot, 'docker', 'Dockerfile')) }];
  const outRoot = join(extensionRoot, 'out');
  for (const folder of ['reviewer', 'shared']) {
    const files = await listJs(join(outRoot, folder));
    for (const file of files.sort()) {
      entries.push({ name: relative(outRoot, file).split('\\').join('/'), data: await readFile(file) });
    }
  }
  return createTar(entries);
};

const shortHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex').slice(0, 12);

const containerSpec = (image: string, options: StartOptions): Record<string, unknown> => ({
  Image: image,
  User: 'node',
  Env: [
    `MALT_PORT=${String(CONTAINER_PORT)}`,
    'MALT_HOST=0.0.0.0',
    'MALT_WORKSPACE=/workspace',
    `MALT_TOKEN=${options.token}`,
    ...Object.entries(options.env).map(([key, value]) => `${key}=${value}`),
  ],
  ExposedPorts: { [`${String(CONTAINER_PORT)}/tcp`]: {} },
  Labels: { 'dev.malt.role': 'reviewer', 'dev.malt.workspace': options.workspaceRoot },
  HostConfig: {
    Mounts: [{ Type: 'bind', Source: options.workspaceRoot, Target: '/workspace', ReadOnly: true }],
    PortBindings: { [`${String(CONTAINER_PORT)}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(options.port) }] },
    ReadonlyRootfs: true,
    Tmpfs: { '/tmp': 'rw,nosuid,size=128m', '/home/node': 'rw,nosuid,size=256m' },
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges'],
    Memory: 1_073_741_824,
    PidsLimit: 256,
  },
});

export class DockerBackend implements ReviewerBackend {
  public readonly kind = 'docker';
  private readonly client: DockerClient;
  private readonly extensionRoot: string;
  private readonly log: LogSink;
  private containerName: string | undefined;

  public constructor(socketPath: string, extensionRoot: string, log: LogSink) {
    this.client = new DockerClient(socketPath);
    this.extensionRoot = extensionRoot;
    this.log = log;
  }

  public async isAvailable(): Promise<boolean> {
    return await this.client.ping();
  }

  public async start(options: StartOptions): Promise<void> {
    const image = await this.ensureImage();
    const name = `malt-reviewer-${shortHash(options.workspaceRoot)}`;
    this.containerName = name;
    await this.remove(name);
    const created = await this.client.sendJson('POST', `/containers/create?name=${name}`, containerSpec(image, options));
    if (created.status !== 201) {
      throw new Error(dockerErrorMessage(created));
    }
    const started = await this.client.sendJson('POST', `/containers/${name}/start`);
    if (started.status !== 204 && started.status !== 304) {
      throw new Error(dockerErrorMessage(started));
    }
    this.log(`Started container ${name} from ${image}`);
  }

  public async stop(): Promise<void> {
    if (this.containerName !== undefined) {
      await this.remove(this.containerName);
      this.log(`Removed container ${this.containerName}`);
    }
  }

  public async isRunning(): Promise<boolean> {
    if (this.containerName === undefined) {
      return false;
    }
    const info = await this.client.inspect('containers', this.containerName);
    const state = isRecord(info) ? info['State'] : undefined;
    return isRecord(state) && state['Running'] === true;
  }

  public async recentLogs(): Promise<string> {
    return this.containerName === undefined ? '' : await this.client.logs(this.containerName, 200);
  }

  private async ensureImage(): Promise<string> {
    const context = await buildContext(this.extensionRoot);
    const tag = `malt-reviewer:${shortHash(context)}`;
    if ((await this.client.inspect('images', tag)) !== undefined) {
      return tag;
    }
    this.log(`Building reviewer image ${tag} (first run can take a few minutes)`);
    await this.client.build(tag, context, this.log);
    return tag;
  }

  private async remove(name: string): Promise<void> {
    const response = await this.client.sendJson('DELETE', `/containers/${name}?force=1`);
    if (response.status !== 204 && response.status !== 404) {
      throw new Error(dockerErrorMessage(response));
    }
  }
}
