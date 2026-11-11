# Issue 62 implementation plan

## Authority and global constraints

The source brief is [issue 62](https://github.com/Division4Studios/multi-agent-local-team/issues/62).
Follow `.agents/AGENTS.md`, `.agents/README.md`, the applicable skills, and the
approved [founder decisions](decisions.md). Work in the user's requested existing
checkout on `feat/62-local-aws-emulator`, based on `dev` at `62f33c6`.

Zero runtime dependencies; no new dev dependencies. No type assertions, `any`,
non-null assertions, suppression comments, or arbitrary process execution.
Keep files <=400 lines, functions <=60 lines and complexity <=10. Generated code
is data-only and linted. Service code imports only its own modules and shared
helpers; extension code talks to its admin API. Signed commits; PR target `dev`.
Spec -> separately authored tests -> implementation -> review -> evidence.

## Task 1: Persist decisions and independent foundation tests

Spec: `specs/aws/foundations.md` and `specs/aws/compatibility.md`.
Write `scripts/test/aws-models.test.mjs` and `scripts/test/aws-sigv4.test.mjs`
against the exact public interfaces in the foundation spec, without reading an
implementation. Use original synthetic fixtures and AWS documentation as the
oracle. Run the tests before the source modules exist and record the expected
missing-module failures. Do not add a test dependency or weaken existing tests.

## Task 2: Model provenance, generation, and credential routing

Implement the foundation specification and satisfy Task 1's tests. Vendor the
pinned original models/notices, record integrity metadata, emit committed tables,
add an offline regeneration check, implement credential parsing, and harden the
new service's import/packaging boundaries. Keep protocol test source/conversion
coverage explicit. Verify `npm run verify`, regeneration and VSIX contents.

## Task 3: STS/SQS walking-skeleton behavior specs and independent tests

Write sourced STS GetCallerIdentity and SQS create/get URL/send/receive/delete
message/delete queue specs, including visibility, scope isolation and explicit
unsupported paths. Independently author pure-module and HTTP integration tests,
including every unimplemented modeled operation. Add admin auth/health/resource/
trace/coverage expectations and state round-trip tests before implementation.
Runtime Node tests live in `scripts/test/aws/` and load Docker-compiled `out/aws`
modules. Run them after compilation locally and against CI's downloaded compiled
artifact; do not depend on Node resolving extensionless TypeScript imports or
introduce a host compiler fallback. Source-only generator and standalone
credential-parser tests stay in the existing tooling-test discovery path.

## Task 4: Implement and verify the standalone walking skeleton

Implement generic initial Query/JSON codecs, typed errors, isolated backends,
gateway, admin API, traces, generated evidence and JSON persistence. Follow the
adapter contract in issue 62. Prove actual HTTP round trips and negative cases.
Do not label operations verified beyond evidence or silently accept unsupported
policy/queue features.

## Task 5: Extension lifecycle, views, terminals, and real tool checks

Add Docker/host startup using the approved boundaries, start/stop/restart, status,
queue resources, coverage view and configured terminal. Add extension tests and
editor acceptance evidence. Verify AWS CLI and one SDK against the running local
gateway. Package exactly the runtime files. Update progress with commands and
results; keep the existing product's suites green.

## Task 6: Step 2 repository-placement decision

F-0 explicitly requires revisiting repository placement at Step 2. Present the
implemented Steps 0–1 evidence and repository size, then obtain that decision
before proceeding to the serverless slice. Subsequent milestones retain the
specification, independent-test and review process from issue 62.

## Review focus

Review untrusted model input, prototype-like names, Unicode and escaping,
duplicate credentials, S3 path preservation, scope isolation, expired receipts,
shutdown/restart races, dishonest unsupported success/coverage, cross-runtime
imports, archive/path containment, secret exposure, consent, and accidental
regressions in the existing reviewer. The original agent-file checkpoint is
commit `152409e`; review implementation changes separately from that imported
collection while checking that its tooling exclusions remain narrow.
