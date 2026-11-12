import { randomUUID } from 'node:crypto';
import { DockerClient } from '../backend/dockerApi';
import { isRecord } from '../shared/guards';
import { AwsAdminClient } from './adminClient';
import type { AwsBackend, AwsBackendOptions, AwsBackendStart, AwsEndpoint } from './backend';
import { awsBuildContext, awsHash } from './dockerContext';
import { awsContainerSpec, socketIdentity } from './dockerSpec';
import { pause, runtimeReady } from './runtimeReady';
import { backendEndpoint, validateBackendStart } from './startOptions';

interface OwnedContainer { readonly id: string; readonly admin: AwsAdminClient }
interface PendingContainer { readonly name: string; readonly labels: Readonly<Record<string, string>>; readonly admin: AwsAdminClient }
const createdId = (body: Buffer): string => {
  const data: unknown = JSON.parse(body.toString('utf8'));
  if (!isRecord(data) || typeof data['Id'] !== 'string' || data['Id'] === '') { throw new Error('Local AWS container ID missing.'); }
  return data['Id'];
};

export class AwsDockerBackend implements AwsBackend {
  public readonly kind = 'docker';
  private readonly options: AwsBackendOptions & { readonly socketPath: string };
  private readonly engine: DockerClient;
  private owned: OwnedContainer | undefined;
  private creating: PendingContainer | undefined;
  private starting = false;
  public constructor(options: AwsBackendOptions & { readonly socketPath: string }) {
    this.options = options; this.engine = new DockerClient(options.socketPath);
  }
  public async isAvailable(): Promise<boolean> { return await this.engine.ping(); }
  public async start(options: AwsBackendStart): Promise<AwsEndpoint> {
    if (this.starting || this.owned !== undefined || this.creating !== undefined) { throw new Error('Local AWS Docker already owns a container.'); }
    this.starting = true;
    try {
      await validateBackendStart(options);
      const image = await this.image();
      const identity = await socketIdentity(this.options.socketPath, await this.engine.info());
      const owner = randomUUID();
      const workspace = awsHash(options.workspaceRoot);
      const labels = { 'dev.malt.role': 'aws-gateway', 'dev.malt.workspace': workspace, 'dev.malt.owner': owner };
      const name = `malt-aws-${workspace.slice(0, 12)}-${owner}`;
      const endpoint = backendEndpoint(options);
      const admin = new AwsAdminClient({ url: endpoint.adminUrl, token: options.token });
      this.creating = { name, labels, admin };
      const response = await this.engine.sendJson('POST', `/containers/create?name=${name}`, awsContainerSpec(image, options, identity, labels));
      if (response.status !== 201) { throw new Error('Local AWS container creation failed.'); }
      const id = createdId(response.body);
      this.owned = { id, admin };
      this.creating = undefined;
      const started = await this.engine.sendJson('POST', `/containers/${encodeURIComponent(id)}/start`);
      if (started.status !== 204 && started.status !== 304) { throw new Error('Local AWS container start failed.'); }
      await runtimeReady(admin, () => false);
      this.options.log('Local AWS Docker gateway is ready.');
      return endpoint;
    } catch {
      await this.stop();
      throw new Error('Local AWS Docker startup failed. Check engine, state access and port availability.');
    } finally { this.starting = false; }
  }
  public async stop(): Promise<void> {
    try {
      await this.recoverCreated();
      const owned = this.owned;
      if (owned === undefined) { return; }
      let graceful = false;
      try { graceful = await this.shutdown(owned); }
      catch { this.options.log('Local AWS Docker graceful shutdown could not be confirmed.'); }
      const response = await this.engine.sendJson('DELETE', `/containers/${encodeURIComponent(owned.id)}?force=1`);
      if (response.status !== 204 && response.status !== 404) { throw new Error('Cleanup refused.'); }
      this.owned = undefined;
      if (!graceful) { throw new Error('Graceful shutdown failed.'); }
      this.options.log('Local AWS Docker gateway removed.');
    } catch { throw new Error('Local AWS Docker shutdown or owned container cleanup failed.'); }
  }
  /** A lost create response requires independent verification of every current ownership label. */
  private async recoverCreated(): Promise<void> {
    const creating = this.creating;
    if (creating === undefined) { return; }
    const info = await this.engine.inspect('containers', creating.name);
    const config = isRecord(info) ? info['Config'] : undefined;
    const labels = isRecord(config) ? config['Labels'] : undefined;
    if (isRecord(info) && typeof info['Id'] === 'string' && isRecord(labels)
      && Object.entries(creating.labels).every(([key, value]) => labels[key] === value)) {
      this.owned = { id: info['Id'], admin: creating.admin };
    }
    this.creating = undefined;
  }
  private async shutdown(owned: OwnedContainer): Promise<boolean> {
    if (!await this.running(owned.id)) { return true; }
    let acknowledged = true;
    try { await owned.admin.shutdown(); }
    catch { acknowledged = false; }
    const deadline = Date.now() + 3_000;
    while (await this.running(owned.id)) {
      if (Date.now() >= deadline) { return false; }
      await pause(50);
    }
    return acknowledged;
  }
  private async running(id: string): Promise<boolean> {
    const info = await this.engine.inspect('containers', id);
    if (info === undefined) { return false; }
    const state = isRecord(info) ? info['State'] : undefined;
    if (!isRecord(state) || typeof state['Running'] !== 'boolean') { throw new Error('Local AWS container state is unavailable.'); }
    return state['Running'];
  }
  private async image(): Promise<string> {
    const context = await awsBuildContext(this.options.extensionRoot);
    const tag = `malt-aws:${awsHash(context)}`;
    if (await this.engine.inspect('images', tag) === undefined) {
      this.options.log('Building Local AWS runtime image.');
      // Engine output may contain untrusted paths or diagnostics; keep the UI/log boundary static.
      await this.engine.build(tag, context, () => undefined);
    }
    return tag;
  }
}
