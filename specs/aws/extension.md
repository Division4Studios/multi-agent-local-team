# Local AWS Emulator extension integration

This is Task 5, after the runtime in [runtime](runtime.md). Follow
`.agents/AGENTS.md`, `docs/design.md`, `docs/editor-testing.md` and approved F-3.
Use native VS Code UI and the existing Docker HTTP client/tar writer. The
extension calls parsed admin APIs; it never imports AWS service implementations.
Public independent-test seams are in [extension APIs](extension-apis.md).

## Lifecycle

Register `malt.aws.start`, `.stop`, `.restart`, `.reset`, `.refresh`,
`.showCoverage`, `.showTraces`, `.openResource` and `.openTerminal`.
Starting requires a trusted workspace. Commands reject absent/untrusted workspace
with a clear message. Reset requires explicit confirmation because it removes
the user's local resources. No automatic start on extension activation.

The manager exposes stopped/starting/running/stopping/unhealthy/error states and
request count. Serialize lifecycle actions; stop/dispose during startup must
invalidate late results and remove any container/process it created. Failed
startup cleans up its owned backend and port/lock resources. Health checks every
10 seconds must ignore results from an older instance. A fresh 32-byte random
admin token is generated on each start, kept in memory, and never logged.

Settings under `malt.aws`:

| Setting | Default / scope |
| --- | --- |
| backend | `auto` (prefer Docker, host fallback); `docker` and `host` pins supported; machine |
| port | 4566, integer 1–65535 |
| bindAddress | `127.0.0.1`; machine; wider binding explicitly warns before starting |
| stateDirectory | `.malt/aws`; relative within workspace; resolve real containment before use |
| region | `us-east-1`; syntactically valid arbitrary signing region |
| terminal.inject | false; opt-in terminal environment collection |

Reuse the existing machine-scoped Docker socket setting. Only register settings
with implemented behavior in this milestone. Future policy, Lambda, image and
snapshot settings arrive with their features, not inert controls.

## Host and Docker backends

Host startup extends only `src/backend/hostBackend.ts`, the approved process
boundary, to run the fixed `out/aws/main.js` entry point with VS Code's Node
runtime. It accepts typed emulator startup options, not an arbitrary executable
or entry-point string. Preserve existing reviewer startup and shutdown. Use a
minimal environment sufficient for the Node process, avoiding inherited cloud
credentials. Request authenticated graceful shutdown before the existing
bounded terminate/kill fallback, especially on Windows.

The gateway Docker image uses the existing approved node:24-slim digest, with
only out/aws, out/shared, generated test evidence and exact license notices.
The build context is explicit and deterministic, and the image tag hashes it.
No npm install in the runtime image. Runtime command is node aws/main.js.

Before the first Docker start, explain that its read-write Docker socket grants
control of local containers, and ask consent; retain that versioned choice in
global state. Refusal must not mount the socket. Auto mode may offer the approved
host alternative; a pinned Docker backend reports that consent is required.

Gateway container requirements:

- Non-root user, read-only root, dropped capabilities, no-new-privileges,
  memory/PID limits and writable tmpfs. State mount is the contained directory;
  no full-workspace writable mount.
- Docker socket mount read-write after consent. On native Linux derive the
  socket's actual group for access; on Docker Desktop handle its internal Linux
  socket explicitly. Access is authorized by the socket consent, not by running
  the container as root.
- `dev.malt.role=aws-gateway`, `dev.malt.workspace=<workspace identity>` and a
  per-start ownership label. Never delete another container merely because its
  name matches. Cleanup only an ID created by this start or independently
  verified ownership matching all expected labels.
- Gateway publication uses the selected host binding; admin publication is
  always 127.0.0.1. Inside-container listeners may bind 0.0.0.0. Return queue URLs
  with the host-published endpoint, using the advertised-endpoint option.
- Gracefully shut down and save before removing the owned container. Preserve
  persistent state and report cleanup failure rather than claiming stopped.

## UI and terminals

The MALT activity-bar container gains `malt.aws` titled Local AWS Emulator. Show
state, service rows and resource rows with stable IDs, native product icons and
text labels. Queue rows open a read-only JSON document supplied by parsed admin
data. Coverage and recent traces likewise open read-only documents in this
milestone; no new webview framework. Refresh never steals editor focus. Surface
errors explicitly rather than showing stale resources as current.

The status bar shows a native cloud/status icon, Local AWS state and request
count, with the endpoint/backend in its tooltip. Its action opens the view or
starts the service, as appropriate. Do not rely on color to convey state.

`malt.aws.openTerminal` starts or requires the local gateway, then creates a
terminal named `MALT Local AWS` using `vscode.window.createTerminal`. Set:

- AWS_ENDPOINT_URL and AWS_ENDPOINT_URL_STS/SQS/S3 to the local HTTP origin;
- AWS_ACCESS_KEY_ID=test and AWS_SECRET_ACCESS_KEY=test;
- AWS_REGION and AWS_DEFAULT_REGION to the configured region;
- AWS_EC2_METADATA_DISABLED=true and AWS_PAGER empty;
- remove inherited AWS_SESSION_TOKEN, AWS_SECURITY_TOKEN, AWS_PROFILE and
  AWS_DEFAULT_PROFILE so
  real credentials cannot override the local setup.

Opt-in terminal injection uses EnvironmentVariableCollection only while the
gateway is running; stop/dispose clears it. Changing endpoint/region refreshes
the collection for new terminals. Expose the pure environment function in
`src/cloud/terminal.ts` as `terminalEnvironment(endpoint, region)` for tests.
It returns `Record<string, string | null>` matching TerminalOptions.env, using
null for inherited values that must be deleted.

The collection's `delete` removes a mutator, not an inherited environment
variable. For opt-in injection, use `replace` with empty session/security tokens
and an isolated `malt-local` profile instead. Write a fixed `terminal-profile.ini`
under the contained state directory, refusing linked/nonregular destinations.
It contains only `[profile malt-local]` with the configured region and
`[malt-local]` with dummy `test` access/secret keys. Set both AWS_PROFILE and
AWS_DEFAULT_PROFILE to `malt-local`, and both AWS_CONFIG_FILE and
AWS_SHARED_CREDENTIALS_FILE to this file. Never read or rewrite the user's AWS
files. The collection is nonpersistent and is cleared on stop/dispose; existing
terminals retain their environment until closed, as with VS Code's standard
process-creation mutations. Dedicated Local AWS terminals still use null removals.

Authority: VS Code 1.144 `EnvironmentVariableCollection.delete/replace` semantics
and network-disabled Boto3 1.42.97 probes. Empty/default named profiles without
configuration failed with ProfileNotFound; the isolated dummy-profile setup
successfully created a local SQS client with dummy credentials and no session
token. Actual gateway round trips remain part of Task 5 acceptance.

## Verification

Independently author tests before implementation. Extension-host tests use the
existing TestCase[] harness for command registration, native resource tree IDs,
terminal configuration, parsed admin failures, startup cancellation, stale health
results, first-start consent, cleanup ownership and reviewer regression.
Container-shape tests inspect security/mount/publication fields and actual Docker
acceptance verifies startup, restart/persistence and shutdown.

After npm run verify, exercise the commands in a disposable Extension Development
Host. From a terminal created by malt.aws.openTerminal, run pinned AWS CLI and an
AWS SDK against its local endpoint: create queue, send, receive, delete message,
delete queue, plus an asserted unsupported call. Record actual tool versions and
commands; no automatic real AWS calls. Record OS/editor/theme, checks performed,
and any human visual/focus checks still outstanding, rather than claiming a human
pass from automation alone.
