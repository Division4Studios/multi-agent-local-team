/** Original synthetic extension DTOs transcribed from the reviewed public contracts. */
import type { AwsManagerDependencies, AwsStartRequest } from '../../cloud/manager';
import type { AwsEndpoint } from '../../cloud/backend';

export type AdminApi = ReturnType<AwsManagerDependencies['client']>;
export type Health = Awaited<ReturnType<AdminApi['health']>>;
export type Resources = Awaited<ReturnType<AdminApi['resources']>>;
export type QueueResource = Resources['resources'][number];
export type Coverage = Awaited<ReturnType<AdminApi['coverage']>>;
export type Traces = Awaited<ReturnType<AdminApi['traces']>>;

export const TEST_TOKEN = 'task5-admin-token-0123456789abcdef0123456789abcdef';
export const TEST_ENDPOINT: AwsEndpoint = { gatewayUrl: 'http://127.0.0.1:4566', adminUrl: 'http://127.0.0.1:14566' };
export const healthValue = (requestCount = 0): Health => ({ status: 'running', requestCount, services: ['sqs', 'sts'] });

export const queueValue = (name = 'orders', region = 'us-east-1', account = '000000000000', port = 4566): QueueResource => ({
  service: 'sqs', account, region, type: 'queue', name, id: `arn:aws:sqs:${region}:${account}:${name}`,
  details: {
    queueUrl: `http://127.0.0.1:${String(port)}/${account}/${region}/${name}`,
    attributes: { VisibilityTimeout: '30', DelaySeconds: '0', MessageRetentionPeriod: '345600', MaximumMessageSize: '1048576', ReceiveMessageWaitTimeSeconds: '0' },
    messageCounts: { available: 1, delayed: 2, inFlight: 3 },
  },
});

export const coverageValue = (): Coverage => ({ services: [
  { service: 'sqs', operations: [{ operation: 'CreateQueue', status: 'partial', testKinds: ['unit'], limitations: ['Standard queues only'] }] },
  { service: 'sts', operations: [{ operation: 'GetCallerIdentity', status: 'partial', testKinds: [], limitations: ['Default root identity'] }] },
] });

export const tracesValue = (): Traces => ({ traces: [{
  id: 'task5-trace', service: 'sqs', operation: 'CreateQueue', account: '000000000000', region: 'us-east-1',
  principalArn: 'arn:aws:iam::000000000000:root', identity: 'default-root',
  statusCode: 200, durationMs: 0.5, decision: 'Default root authorization',
}] });

export const startRequest = (workspaceRoot: string): AwsStartRequest => ({
  workspaceRoot, trusted: true, backend: 'host', bindAddress: '127.0.0.1', port: 4566,
  stateDirectory: '.malt/aws', region: 'us-east-1',
});
