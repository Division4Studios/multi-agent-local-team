export interface AccountRegion { readonly account: string; readonly region: string }
export type OperationStatus = 'unsupported' | 'stubbed' | 'partial' | 'verified' | 'simulated';
export type TestKind = 'unit' | 'protocol' | 'lifecycle' | 'workflow' | 'differential';
export interface EvidenceCase { readonly id: string; readonly operations: readonly string[]; readonly kind: TestKind }
export type QueueAttributeName = 'VisibilityTimeout' | 'DelaySeconds' | 'MessageRetentionPeriod'
  | 'MaximumMessageSize' | 'ReceiveMessageWaitTimeSeconds';
export type QueueAttributes = Readonly<Record<QueueAttributeName, string>>;
export interface AwsQueueResource extends AccountRegion {
  readonly service: 'sqs';
  readonly type: 'queue';
  readonly name: string;
  readonly id: string;
  readonly details: {
    readonly queueUrl: string;
    readonly attributes: QueueAttributes;
    readonly messageCounts: { readonly available: number; readonly delayed: number; readonly inFlight: number };
  };
}
export interface AwsResources { readonly resources: readonly AwsQueueResource[] }
export interface AwsOperationCoverage {
  readonly operation: string;
  readonly status: OperationStatus;
  readonly testKinds: readonly TestKind[];
  readonly limitations: readonly string[];
}
export interface AwsCoverage {
  readonly services: readonly { readonly service: string; readonly operations: readonly AwsOperationCoverage[] }[];
}
export interface AwsTrace extends AccountRegion {
  readonly id: string;
  readonly service: string;
  readonly operation: string;
  readonly principalArn: string;
  readonly identity: 'default-root';
  readonly statusCode: number;
  readonly durationMs: number;
  readonly decision: string;
}
export interface AwsTraces { readonly traces: readonly AwsTrace[] }
export interface AwsHealth {
  readonly status: 'running';
  readonly requestCount: number;
  readonly services: readonly string[];
}
