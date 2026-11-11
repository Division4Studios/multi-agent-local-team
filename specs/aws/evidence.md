# Executed compatibility evidence

This supplements [runtime](runtime.md). Declaring a handler or vendoring a model
does not establish testing. Coverage comes from the actual operation map plus
successful independent test results bound to the executable files.

## Test identifiers

Tests contributing AWS evidence use this original naming convention:

`aws[service.Operation,service.Operation;kind] descriptive assertion`

Examples:

- `aws[sqs.CreateQueue,sqs.GetQueueUrl;unit] queue settings and scope isolation`
- `aws[sqs.SendMessage,sqs.ReceiveMessage;protocol] JSON to Query round trip`
- `aws[sts.AssumeRole;protocol] modeled operation explicitly unsupported`

Kinds are `unit`, `protocol`, `lifecycle`, `workflow`, or `differential`. Name each
operation actually asserted by that test. Do not credit every operation in a
service because one happy path passed. Unsupported-operation assertions may add
testKinds but cannot change the operation's unsupported status. CLI/SDK round
trips are workflow evidence with pinned external-tool versions in their receipt.

## Collection

A Node test reporter consumes real `node:test` pass/fail/skip events, not console
text invented by a handler. It writes no successful-run evidence if any test
fails, is cancelled, or if the process fails to reach its final summary. Skipped
or todo tests are not successful cases. The reporter first invalidates any prior
artifact so a failed run cannot leave apparently fresh evidence.

Only after successful completion, write `out/aws/test-evidence.json`:

```json
{
  "formatVersion": 1,
  "runtimeDigest": "<sha256 of runtime inventory>",
  "cases": [
    { "id": "<full test name>", "operations": ["sqs.CreateQueue"], "kind": "unit" }
  ]
}
```

The runtime digest covers every `.js` file under `out/aws` and `out/shared`,
sorted by forward-slash relative path; hash each UTF-8 path, a NUL separator,
file bytes, and a NUL separator. Tests execute these Docker-compiled files.
Exclude non-JavaScript artifacts. Refuse symlinks or non-files when collecting
the inventory. This digest algorithm is shared by reporter/runtime; no repeated
hand-copied hashing implementation. The reporter can import the compiled helper.

The artifact is generated, ignored with out/, and explicitly shipped only after
the AWS tests run. Tests may initially run without an artifact. Runtime parses
the artifact and checks its digest; absent, malformed or stale evidence produces
empty testKinds rather than a compatibility claim. The service's supported
subset remains partial with its known limits even when every available test
passes. Evidence never authorizes an operation or suppresses errors.

Generate the live coverage report from the operation map plus validated evidence
and save it to `<stateDirectory>/coverage.json` using the state path boundary.
`GET /coverage` returns the same data. Do not allow a request or imported state
document to supply testing claims. The extension only renders the parsed report.

## Verification

Independent tests cover pass/failure/skipped event handling, inventory binding,
malformed evidence and stale-digest rejection. Runtime tests assert inventory and
status without needing a self-referential artifact; a subsequent fresh process
verifies that the generated artifact credits only the executed operation/kind
pairs. The existing verification and packaging commands explicitly order Docker
compilation, runtime tests/reporting, and VSIX creation (npm hooks are disabled).
