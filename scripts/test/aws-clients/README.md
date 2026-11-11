# Opt-in real-client acceptance

Run this **later, after runtime/extension implementation**, from the dedicated
**MALT Local AWS** terminal opened by `malt.aws.openTerminal`:

```text
node scripts/test/aws-clients/run.mjs --container "FULL_64_HEX_GATEWAY_CONTAINER_ID" --receipt "ABSOLUTE_OWNED_RECEIPT_PATH.json"
```

The controller supplies the full ID of its already-running Linux gateway
container. Its listener must be reachable on the terminal's advertised loopback
port inside that container (normally `127.0.0.1:4566`). Clients use
`--network container:<id>`. The receipt's parent directory must already exist
at a physical path. A new receipt is created, or an existing receipt of this
harness's kind is replaced. Unrelated, linked and hardlinked files are refused.

## Terminal and tool prerequisites

- Node 24+ and the Docker client/engine; the exact immutable CLI and Python
  images in `specs/aws/images.md` must already be cached. Runs use `--pull never`.
- `AWS_ENDPOINT_URL`: loopback HTTP origin, without userinfo/path/query/fragment.
- `AWS_ACCESS_KEY_ID=test`, `AWS_SECRET_ACCESS_KEY=test`.
- No active session/security token or profile. Use the dedicated terminal;
  the separate opt-in environment-collection profile is not this invocation.
- Nonempty signing region via `AWS_REGION`/`AWS_DEFAULT_REGION`; if both are
  present they must agree. Service endpoint overrides must agree too.
- `AWS_EC2_METADATA_DISABLED=true`.

The harness forwards an explicit environment allowlist, disables proxies and
metadata, supplies no host AWS files, and passes the endpoint explicitly to each
client. It validates this environment; terminal provenance is recorded by the
controller during actual editor acceptance.

## Assertions and cleanup

The CLI and original Python/Boto3 fixture independently verify actual versions,
default STS account/ARN/UserId, canonical scoped create/get URLs, send/receive body
and UTF-8 MD5, delivery identity and an opaque receipt, deletion after a
**zero-visibility** receive, queue deletion and modeled missing-queue lookup, and
an `UnsupportedOperation` error whose message names `ListQueues` and explains
that it is unsupported. Names and bodies are unique original fixtures.

There is one transport attempt per operation, 3-second connect and 5-second read
timeouts, and a 1.1-second allowance for documented queue creation readiness.
CLI containers have a 20-second deadline; the SDK container has 120 seconds;
the entire invocation has 300 seconds plus bounded cleanup. Owned containers use
`--rm`, read-only root, UID/GID 1000, no capabilities/new privileges, bounded
CPU/memory/PIDs and a small temporary filesystem. Host processes are force-killed
on timeout/cancellation and their exit is awaited. Cleanup checks an owned
container's unique label before removal, with 5-second inspect/removal deadlines.

Each client cleans up only its uniquely named queue after confirmed creation.
Ownership and unconfirmed cleanup are retained until `GetQueueUrl` returns the
modeled missing-queue error. Delete acknowledgement alone does not establish
absence; normal, fallback and cleanup-only paths all verify the lookup.
An interrupted SDK with an observed successful create gets one bounded SDK
cleanup attempt. If a create request loses its response before ownership can be
confirmed, queue cleanup is uncertain: the failed receipt identifies the unique
queue name for controller reconciliation. Docker/daemon cleanup failure also
keeps the run failed.

## Receipt and preparation checks

The JSON receipt contains observed versions, immutable image references/digests,
endpoint/region, gateway ID, executed checks, cleanup outcomes and overall
success. Credentials, tokens, bodies and receipts are not copied into it. An
owned prior success is replaced with `success: false` once the unambiguous receipt
path passes ownership validation, before remaining argument/environment validation
or Docker work; successful completion is written atomically. Invalid, ambiguous
or unwritable receipt destinations fail rather than overwrite unrelated data.
Treat a receipt as successful only alongside this invocation's zero exit status.

This receipt is separate from compiled `test-evidence.json`. It does not publish
workflow coverage or prove editor visual/focus acceptance.

SDK recovery records sanitized `cleanupChecks`, `cleanupOutcome` and any
`cleanupFailure` even when recovery fails or stdout ends mid-event. Complete
checks preceding an interrupted event remain recorded. Observed absence can be
confirmed even if a later execution error fails recovery; neither successful
cleanup nor partial recovery evidence replaces the original acceptance failure.

Explicit preparation commands (files intentionally avoid `*.test.mjs` discovery):

```text
node --test scripts/test/aws-clients/controls.mjs
node --test scripts/test/aws-clients/docker-controls.mjs
node --experimental-test-module-mocks --test scripts/test/aws-clients/recovery-controls.mjs
```

The second command uses only owned, network-disabled pinned Python containers
to parse the fixture, prove timeout cleanup, and verify truthful queue-cleanup
reporting after genuine SDK connection failures to an unbound loopback port.
It also runs explicitly synthetic Python Stubber recovery controls. The separate
Node recovery controls mock only the process boundary in an isolated test
process. Their fault responses/transcripts test failure handling, produce no
acceptance receipt and receive no compatibility credit. These commands perform
no gateway round trips or historical version re-probes. Actual client round trips
remain Task5 acceptance.
