# Local AWS Emulator

Local AWS runs a local, persistent STS/SQS walking skeleton alongside MALT's
reviewer. It starts only on request in a trusted local workspace. It makes no
fallback requests to real AWS.

## Start and use

1. Open **MALT → Local AWS Emulator**, then choose **Start Local AWS Emulator**.
2. Auto mode prefers a Linux Docker engine. The first Docker start asks permission
   to mount its socket **read-write**. This permits control of local containers
   and can provide host-level access; the affirmative choice is remembered on
   this machine. If Docker is unavailable or declined, auto mode offers a host
   process running with your user permissions. A pinned Docker backend fails
   rather than silently switching.
3. Choose **Open Local AWS Terminal**. It creates `MALT Local AWS` with the running
   gateway endpoint, configured region, dummy `test` credentials, disabled instance
   metadata and no pager. Use this terminal for local CLI/SDK work. Shell startup
   scripts can change environment variables; keep the explicit local endpoint.
4. Expand **SQS** and select a queue for read-only JSON. **Show Local AWS Coverage**
   and **Show Local AWS Recent Traces** open read-only documents too. Refresh updates
   the tree without opening an editor. Status includes state, request count,
   backend and endpoint; errors clear stale resource rows.

**Stop** requests authenticated shutdown/save and awaits owned process/container
cleanup. **Restart** stops first, then reads current settings. **Reset Local AWS
Resources** asks confirmation before removing all local resources and messages.
State stays on disk after stop. An error during shutdown or cleanup means saved
state and cleanup are not confirmed; inspect the status/output before restarting.

## Settings

| Setting | Default | Behavior |
| --- | --- | --- |
| `malt.aws.backend` | `auto` | Machine-scoped; `docker` and `host` pins available |
| `malt.aws.port` | `4566` | Gateway port, 1–65535; next start |
| `malt.aws.bindAddress` | `127.0.0.1` | Machine-scoped IP; wider binds require confirmation every start |
| `malt.aws.stateDirectory` | `.malt/aws` | Relative, strictly inside workspace; next start |
| `malt.aws.region` | `us-east-1` | Arbitrary syntactically valid signing region for new terminals |
| `malt.aws.terminal.inject` | `false` | Opt in to local AWS settings for new ordinary terminals while running |

Docker uses the existing machine-scoped `malt.docker.socketPath`. The gateway
has a separate authenticated admin port published only on `127.0.0.1`. Its image
contains the shipped runtime, shared modules, matching test evidence and notices.
The container is non-root with a read-only root, dropped capabilities,
no-new-privileges, memory/PID limits, temporary writable storage and a writable
mount of only the state directory. Native Linux derives socket group access;
Docker Desktop mounts its internal Linux socket explicitly.

State and terminal-profile paths reject linked components. The fixed
`terminal-profile.ini` must be absent or a regular single-link file. It contains
only dummy credentials and the signing region; MALT does not rewrite user AWS
configuration files. Stop leaves this dummy file intact.

## Terminal injection

With injection off, the dedicated terminal removes inherited profile selectors
and session/security tokens using four null environment entries. With injection
on, the native collection can reintroduce only `malt-local` selectors, the
contained dummy-profile paths and empty tokens. Both modes override the supported
endpoint variables and credentials. Native terminal inheritance is retained;
MALT neither sets `strictEnv` nor temporarily clears the collection around a
dedicated terminal. See the [native precedence measurement](aws-terminal-precedence.md).

Injection is nonpersistent and clears when the gateway leaves running state or
the feature is disposed. Existing terminals keep their process environment until
closed. Changing injection or region affects newly created terminals.

## Current compatibility and acceptance limits

- STS supports `GetCallerIdentity`; SQS supports the documented queue/message
  subset. Unsupported operations fail explicitly. S3 endpoint variables are
  configured for consistency, but S3 is not implemented.
- Signing scopes are parsed; this milestone does not validate real secrets or
  implement IAM policy management/temporary credentials. Requests resolve to a
  fixed default root identity. Coverage exposes these limitations and records
  only evidence matching the executable runtime.
- Native test automation does not establish genuine trust/dialog consent or human
  theme, keyboard and focus acceptance. Production-terminal CLI/SDK provenance
  and human acceptance are separate release gates. The pinned acceptance harness
  runs with injection **off**; ordinary injected and combined dedicated terminals
  require separate actual-process environment checks.
