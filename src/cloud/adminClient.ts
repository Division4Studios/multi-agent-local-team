import { parseAwsAcknowledgement, parseAwsCoverage, parseAwsHealth, parseAwsResources, parseAwsTraces } from '../shared/aws/parsers';
import { parseScope } from '../shared/aws/validation';
import type { AccountRegion, AwsCoverage, AwsHealth, AwsResources, AwsTraces } from '../shared/aws/types';
import { adminRequest, validateAdminEndpoint } from './adminTransport';
import type { AdminEndpoint } from './adminTransport';

export interface AwsAdminApi {
  health(): Promise<AwsHealth>;
  resources(): Promise<AwsResources>;
  coverage(): Promise<AwsCoverage>;
  traces(): Promise<AwsTraces>;
  save(): Promise<void>;
  reset(scope: 'all' | AccountRegion): Promise<void>;
  shutdown(): Promise<void>;
}

export class AwsAdminClient implements AwsAdminApi {
  private readonly endpoint: AdminEndpoint;
  public constructor(endpoint: AdminEndpoint) {
    validateAdminEndpoint(endpoint);
    this.endpoint = { ...endpoint };
  }
  public async health(): Promise<AwsHealth> { return await this.read('/health', parseAwsHealth); }
  public async resources(): Promise<AwsResources> { return await this.read('/resources', parseAwsResources); }
  public async coverage(): Promise<AwsCoverage> { return await this.read('/coverage', parseAwsCoverage); }
  public async traces(): Promise<AwsTraces> { return await this.read('/traces', parseAwsTraces); }
  public async save(): Promise<void> { await this.mutate('/save', {}, 'saved'); }
  public async shutdown(): Promise<void> { await this.mutate('/shutdown', {}, 'stopping'); }
  public async reset(scope: 'all' | AccountRegion): Promise<void> {
    const parsed = scope === 'all' ? scope : parseScope(scope);
    if (parsed === undefined) { throw new Error('Invalid Local AWS reset scope.'); }
    await this.mutate('/reset', { scope: parsed }, 'reset');
  }
  private async read<T>(route: string, parse: (value: unknown) => T | undefined): Promise<T> {
    const result = parse(await adminRequest(this.endpoint, route));
    if (result === undefined) { throw new Error('Invalid Local AWS admin response.'); }
    return result;
  }
  private async mutate(route: string, body: unknown, key: 'saved' | 'reset' | 'stopping'): Promise<void> {
    if (!parseAwsAcknowledgement(await adminRequest(this.endpoint, route, body), key)) {
      throw new Error('Invalid Local AWS admin acknowledgement.');
    }
  }
}
