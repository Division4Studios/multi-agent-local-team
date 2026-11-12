/** Typed launch boundary shared by the native host and Docker adapters. */
export interface AwsEndpoint { readonly gatewayUrl: string; readonly adminUrl: string }
export interface AwsBackendStart {
  readonly workspaceRoot: string;
  readonly stateDirectory: string;
  readonly bindAddress: string;
  readonly port: number;
  readonly adminPort: number;
  readonly token: string;
}
export interface AwsBackend {
  readonly kind: 'host' | 'docker';
  isAvailable(): Promise<boolean>;
  start(options: AwsBackendStart): Promise<AwsEndpoint>;
  stop(): Promise<void>;
}
export interface AwsBackendOptions {
  readonly extensionRoot: string;
  readonly log: (message: string) => void;
}
