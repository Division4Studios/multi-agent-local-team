# Extension integration boundaries for independent tests

This supplements [extension](extension.md). It fixes the externally observable
seams before Task 5 tests; helper layout and internal implementation remain free.
All extension code communicates through admin HTTP, not service implementation
imports. Types for admin wire data live under `src/shared/aws/`.

## Admin client

`src/cloud/adminClient.ts` exports `AwsAdminClient` constructed with
`{ url: string, token: string }`. The URL must be an HTTP origin on 127.0.0.1
without credentials, path, query or fragment. The token must contain at least
32 characters and no HTTP control characters. Reject invalid configuration
before any request. Each method sends the per-start bearer token:

| Method | Promise value / route |
| --- | --- |
| health() | Parsed health object, GET /health |
| resources() | Parsed resources envelope, GET /resources |
| coverage() | Parsed coverage envelope, GET /coverage |
| traces() | Parsed traces envelope, GET /traces |
| save() | void after validated `{ saved: true }`, POST /save `{}` |
| reset(scope) | void after validated `{ reset: true }`, POST /reset `{ scope }` |
| shutdown() | void after validated `{ stopping: true }`, POST /shutdown `{}` |

Scope is `'all'` or `{ account, region }`. The response objects are the shapes in
[runtime](runtime.md), validated from unknown values; no assertions/casts.
Reject non-2xx, non-JSON, malformed/oversized/truncated responses and invalid
fields. Cap responses at 2 MiB and requests at a five-second deadline. Never
follow redirects or include the token/body in errors. Count/duration values are
finite nonnegative numbers (counts integers); statuses/test kinds are the defined
unions. Resources expose metadata/counts only, and traces contain only the fixed
runtime trace fields. Invalid or extra secret-bearing fields are rejected.

## Backends and lifecycle

`src/cloud/backend.ts` exports `AwsBackend`, `AwsBackendStart`, and `AwsEndpoint`:

```ts
interface AwsEndpoint { readonly gatewayUrl: string; readonly adminUrl: string; }
interface AwsBackendStart {
  readonly workspaceRoot: string;
  readonly stateDirectory: string; // absolute, validated before backend invocation
  readonly bindAddress: string;
  readonly port: number;
  readonly adminPort: number; // allocated loopback host port
  readonly token: string;
}
interface AwsBackend {
  readonly kind: 'host' | 'docker';
  isAvailable(): Promise<boolean>;
  start(options: AwsBackendStart): Promise<AwsEndpoint>;
  stop(): Promise<void>;
}
```

`src/cloud/manager.ts` exports `AwsManager` and its dependencies/start types.
Use structural interfaces so tests can supply bounded fake backend/network/UI
promises without replacing global VS Code methods or private class internals.

```ts
interface AwsStartRequest {
  readonly workspaceRoot: string;
  readonly trusted: boolean;
  readonly backend: 'auto' | 'host' | 'docker';
  readonly bindAddress: string;
  readonly port: number;
  readonly stateDirectory: string; // relative strictly within workspace
  readonly region: string;
}
interface AwsManagerDependencies {
  readonly docker: AwsBackend;
  readonly host: AwsBackend;
  readonly hasSocketConsent: () => boolean;
  readonly requestSocketConsent: () => Promise<boolean>;
  readonly storeSocketConsent: () => Promise<void>;
  readonly confirmHostFallback: () => Promise<boolean>;
  readonly confirmExternalBind: (address: string) => Promise<boolean>;
  readonly client: (endpoint: { readonly url: string; readonly token: string }) => AwsAdminApi;
  readonly log: (message: string) => void;
}
```

`AwsAdminApi` is the structural client interface with the methods above, using
shared parsed response types. `new AwsManager(dependencies)` provides:

- readonly `status`: `{ state, requestCount, detail, backend?, endpoint?, region? }`,
  with the lifecycle state union from extension.md;
- readonly `client: AwsAdminApi | undefined`, available only while running;
- `onDidChangeStatus`, a VS Code event carrying the same status shape;
- `start(request): Promise<void>`, `stop(): Promise<void>`,
  `checkHealth(): Promise<void>`, and `dispose(): void`.

Initial state is stopped/count zero. Validate workspace trust, options and real
state containment before invoking a backend. Refuse absolute/escaping/linked
state paths; create missing contained directories component by component, then
verify with `realRelativeInside`. Wider gateway binding needs explicit consent
for each start. Docker permission is remembered only after an affirmative
answer. Auto chooses available Docker with consent; unavailable/declined Docker
requires affirmative host fallback. Pinned host does not ask socket consent;
pinned unavailable/unconsented Docker fails clearly.

After backend start, a successful parsed health check transitions to running.
Backend start/initial-health failure cleans up its selected backend. A stop or
dispose invalidates the start immediately, and waits/arranges cleanup even when
the backend promise completes later. A cancelled start rejects explicitly.
Concurrent lifecycle calls are serialized; each start gets a fresh random token.
Periodic and explicit health use the same generation-checked code path; success
updates count, failure marks unhealthy, and a stale result changes nothing.
Stop requests graceful admin shutdown before backend cleanup when possible,
attempts cleanup even if that request fails, and surfaces shutdown/cleanup
failure as error rather than claiming state was saved. A stopped backend does
not retain timers or client access. Restart is
stop then start using fresh settings at the command adapter.

## Native views and testable adapters

`src/cloud/resourcesView.ts` exports `AwsResourcesProvider(manager)` implementing
VS Code TreeDataProvider. `refresh(): Promise<void>` fetches resources through
the current client; failed refresh clears stale data and displays an error row.
Roots include status and the two service rows; SQS children are queue resources.
Stable TreeItem IDs depend on service/scope/resource identity, never row position
or counts. Product icons and text labels convey state; refresh never opens an
editor. Queue items invoke `malt.aws.openResource` with parsed resource data.

`src/cloud/documents.ts` exports `AwsDocuments`, a TextDocumentContentProvider
with `add(kind, value): vscode.Uri` and `provideTextDocumentContent(uri): string`.
Kinds are `resource`, `coverage`, `traces`; serialize validated values as JSON
under the `malt-aws` URI scheme. Keep an owned in-memory bounded cache, no user
filesystem paths or writable editors. Register/dispose it with the feature.

`src/cloud/terminal.ts` exports the `terminalEnvironment` function already
specified in extension.md. Test native command registration/contributions using
the real manifest and activated extension. Consent/trust/reset confirmation
behavior uses injected manager dependencies and the command adapter as needed;
do not add a production command that bypasses these boundaries for tests.

Real host/Docker startup, terminal-created CLI/SDK requests, and theme/focus
acceptance remain integration checks; fake dependencies alone do not establish
those results. `AwsHostBackend` is exported from the existing approved
`src/backend/hostBackend.ts`; `AwsDockerBackend` lives under `src/cloud` and uses
the existing Docker HTTP client. Both constructors accept one options object
`{ extensionRoot, log }`, with `socketPath` also required for Docker. Tests may
use a local fake Docker socket for concrete
container requests and ownership checks. No Docker CLI enters runtime code.
