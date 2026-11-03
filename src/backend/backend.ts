/** A way of running the reviewer service: a Docker container or a host daemon. */
export type BackendKind = 'docker' | 'host';

export interface StartOptions {
  readonly workspaceRoot: string;
  readonly port: number;
  readonly token: string;
  /** Extra environment for the reviewer (models, credentials). */
  readonly env: Readonly<Record<string, string>>;
}

export interface ReviewerBackend {
  readonly kind: BackendKind;
  isAvailable: () => Promise<boolean>;
  start: (options: StartOptions) => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => Promise<boolean>;
  /** Recent reviewer output, for the logs view. */
  recentLogs: () => Promise<string>;
}

export type LogSink = (line: string) => void;
