# Walking-skeleton runtime contracts

Scope: issue 62 Steps 0–1, [compatibility](compatibility.md),
[STS](sts/get-caller-identity.md), and [SQS](sqs/queues-and-messages.md).
These interfaces are the independent tests' entry points. They are local design
contracts; AWS wire behavior comes from the linked operation specifications.

## Backend boundary

`src/aws/services/types.ts` exports the following types (additional internal
helpers are permitted). JSON objects at this boundary have already passed the
protocol decoder; service-specific constraints still belong to the backend.

```ts
interface AccountRegion {
  readonly account: string;
  readonly region: string;
}
interface CallContext extends AccountRegion {
  readonly accessKeyId: string;
  readonly principalArn: string;
  readonly traceId: string;
  readonly emit: (event: Readonly<Record<string, unknown>>) => void;
}
interface ParsedCall {
  readonly operation: string;
  readonly input: Readonly<Record<string, unknown>>;
}
interface OperationSupport {
  readonly status: 'unsupported' | 'stubbed' | 'partial' | 'verified' | 'simulated';
  readonly limitations: readonly string[];
}
interface StateDocument {
  readonly formatVersion: 1;
  readonly service: string;
  readonly scope: AccountRegion;
  readonly data: unknown;
}
interface ServiceBackend {
  readonly service: string;
  readonly operations: ReadonlyMap<string, OperationSupport>;
  handle(call: ParsedCall, context: CallContext): Promise<Readonly<Record<string, unknown>>>;
  exportState(scope: AccountRegion): StateDocument;
  importState(scope: AccountRegion, document: unknown): void;
  reset(scope: AccountRegion | 'all'): void;
}
```

`createStsBackend()` in `src/aws/services/sts/backend.ts` returns ServiceBackend.
`createSqsBackend({ endpoint, now? })` in `src/aws/services/sqs/backend.ts` returns
ServiceBackend; `endpoint` is the configured public origin and `now` defaults to
Date.now (milliseconds). Injected clocks control immediate state transitions;
real timers and the real clock exercise long polls. `AwsError` in
`src/aws/protocol/errors.ts` extends Error with readonly `code`, `statusCode`,
and `fault: 'Sender' | 'Receiver'`. Typed backend failures reject with AwsError.
The services must not import each other's backends.

Export/import includes all behaviorally necessary state, including old receipts.
The exported value is detached: changing it cannot mutate live state. Import
validates versions, service, scope, constraints and relationships before changing
live state. A scope mismatch, non-finite time, duplicate identity or invalid
document fails atomically. Reset of one scope leaves other scopes intact.

Queue URLs use `<endpoint>/<account>/<region>/<QueueName>` so independent regions
cannot alias. Validate origin and path against the configured local endpoint;
never fetch QueueUrl. The gateway may recover QueueUrl from this path only for
legacy Query requests. A conflicting body URL fails explicitly.

## Server entry point

`src/aws/server.ts` exports:

```ts
interface AwsServerOptions {
  readonly host?: string; // default 127.0.0.1
  readonly port?: number; // default 4566; zero permitted for tests
  readonly adminPort?: number; // default zero
  readonly adminToken: string; // caller-generated, at least 32 characters
  readonly stateDirectory: string; // absolute, caller-approved directory
}
interface RunningAws {
  readonly gatewayUrl: string;
  readonly adminUrl: string;
  close(): Promise<void>;
}
export const startAwsServer = (options: AwsServerOptions): Promise<RunningAws>;
```

Admin always binds 127.0.0.1. Gateway binding is explicit; the extension handles
the approved wider-binding warning. Validate configuration before listening.
If either listener fails, close the other and release owned state handles.
`close()` is idempotent, wakes pending polls, stops accepting work, flushes state,
and releases listeners and the state lock. No background activity survives close.

### Gateway

- Public `GET /_health` returns status running and both service names, without
  authentication. Health does not count as an AWS operation.
- Require syntactically valid signing scope for AWS calls. Reject repeated
  Authorization headers as well as header/query ambiguity. Missing/malformed
  signing returns 403 with an explanatory AWS-shaped message.
- For this root-only milestone, syntactically valid keys resolve to the default
  root account. Record `identity: 'default-root'`; this limitation appears in
  coverage. No secret validation, temporary credentials or policy-management
  claims. STS's documented permission exemption and root authorization are
  explicit trace decisions.
- STS accepts Query GET or form POST, version 2011-06-15. SQS accepts legacy Query
  GET/form POST version 2012-11-05, or JSON POST with content type
  application/x-amz-json-1.0 and X-Amz-Target AmazonSQS.Operation.
- Credential service and protocol target must agree. Reject invalid methods,
  versions, malformed JSON/form encoding, duplicate action/version/parameters,
  unknown members and unsupported bindings rather than silently dropping them.
- Parse Query primitive/list/map/structure members by model traits, including
  flattened Attribute.N.Name/Value entries. Enforce required members and types.
  Do not interpret JS prototype properties as input members.
- Body cap: 2 MiB (enough for supported 1 MiB messages plus encoding overhead
  within the cap). Excess produces 413; unsupported content encoding produces an
  explicit error. No stacks or body snippets in unexpected errors.
- Each AWS response includes an x-amzn-requestid header. Query includes matching
  ResponseMetadata/RequestId, correct service namespace and escaped XML. JSON
  modeled structures serialize to objects; modeled Unit outputs have zero bytes.
- JSON errors use `__type`, `message`, and x-amzn-errortype. Query errors use
  ErrorResponse/Error/{Type,Code,Message} and RequestId; map modeled Query error
  traits (notably SQS QueueDoesNotExist). Unsupported operations return status
  400 and code UnsupportedOperation, naming the service and operation. Unknown
  service/protocol/operation also fails explicitly. No outbound AWS requests.

## Admin API

Every route, including health and unknown routes, requires exact
`Authorization: Bearer <per-start token>` (constant-time comparison); absent or
incorrect tokens produce 401. JSON responses, request size limits, strict request
parsing, and no stack exposure apply. Mutations require application/json.

| Route | Response / action |
| --- | --- |
| GET /health | `{ status: 'running', requestCount: number, services: ['sqs', 'sts'] }` |
| GET /resources | `{ resources: [{ service, account, region, type, name, id, details }] }`; queue metadata/counts only, no bodies or receipts |
| GET /coverage | `{ services: [{ service, operations: [{ operation, status, testKinds, limitations }] }] }`; every modeled operation appears |
| GET /traces | `{ traces: [{ id, service, operation, account, region, principalArn, identity, statusCode, durationMs, decision }] }`, newest first |
| POST /save | Body `{}`; flush dirty state; `{ saved: true }` |
| POST /reset | Body `{ scope: 'all' }` or `{ scope: { account, region } }`; reset and save; `{ reset: true }` |

The initial trace ring stores at most 200 entries, and never stores Authorization,
access keys, session tokens, message text or receipts. `decision` is a short
static explanation of root authorization or STS's permission exemption. Unknown
routes are 404; invalid mutation bodies are 400 with no mutation.

Coverage is built from real backend operation declarations and evidence from
successful test runs. Initially all implemented operations remain partial and
all others unsupported. Do not mark unexecuted kinds or stale evidence as passing.
The evidence-generation command records the tested source digest, case IDs,
operations and test kinds only after success. Versioned evidence is shipped with
the runtime through an explicit asset path. The generation/drift contract is
specified separately before that implementation; runtime tests may first assert
the inventory, statuses and limitations with empty testKinds.

## Persistent state

Store versioned JSON under the approved state directory; temporary atomic-write
files and a single-writer lock live there too. Create absent directories but
refuse symlink/junction state roots and linked state files. Confine every path to
that root; names from requests never become filenames. Reject corrupt or unknown
state versions without silently resetting. A second live owner fails clearly.
Do not steal a lock based on age alone.

Flush on admin save, a bounded dirty timer, and shutdown. Reopen preserves queues,
message bodies, delay/visibility/retention deadlines and current/old receipts.
Queue URLs are reconstructed with the current endpoint, not persisted host ports.
Large immutable payload storage uses SHA-256-addressed blobs when externalized;
documents never trust a path stored in imported state. The initial queue-only
document may inline message bodies; package/blob storage begins with Step 2.

## Independent acceptance tests

- Backend tests use supplied contexts/clocks to prove account/region isolation,
  visibility, delay, retention, stale receipts, unsupported fields and atomic
  import. Assert all unsupported operations from the pinned models.
- HTTP tests run the real server on ephemeral ports, exercising Query and JSON
  against shared state, public health, authentication ambiguity, model validation,
  long-poll wakeup, admin boundaries, trace redaction, save/reopen and invalid
  requests that must not mutate state.
- Do not use real AWS or require AWS credentials. CLI/SDK acceptance follows in
  Task 5 with pinned external tools and explicit localhost endpoints.
