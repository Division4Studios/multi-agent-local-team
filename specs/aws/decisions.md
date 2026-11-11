# Local AWS Emulator: founder decisions

Issue: [#62](https://github.com/Division4Studios/multi-agent-local-team/issues/62).
The founder approved the following choices in the development session on
2026-11-11. Recommendations in the original issue are superseded by this record.

| ID | Outcome | Date | Rationale |
| --- | --- | --- | --- |
| F-0 | Build Steps 0–1 inside public, MIT-licensed MALT; revisit repository placement at Step 2. | 2026-11-11 | Reuse MALT's service, editor, and Docker foundations while keeping the larger product-scope decision visible. |
| F-1 | Lint generated data tables under the existing limits. Add emulator service import restrictions without weakening existing rules. | 2026-11-11 | Preserve the existing quality gate and split output in the generator. |
| F-2 | Vendor required Apache-2.0 Smithy models and protocol cases, retaining licenses/notices and immutable source revisions. | 2026-11-11 | Use authoritative schemas and protocol evidence without adding npm dependencies. |
| F-3 | Support Docker (default, read-write Docker socket after first-start consent) and a host fallback through the existing approved host launcher. | 2026-11-11 | Support both deployment environments with explicit startup boundaries. |
| F-4 | Versioned JSON documents and content-addressed blobs first; consider built-in SQLite only after measurement and migration design. | 2026-11-11 | Keep initial persistence inspectable and dependency-free. |
| F-5 | Initial runtime defaults: Lambda nodejs22.x, python3.13, and PostgreSQL 17; resolve and record immutable image digests. | 2026-11-11 | Deliberate, reproducible runtime versions and supply-chain updates. |
| F-6 | Feature name: Local AWS Emulator. Settings and command prefix: malt.aws. | 2026-11-11 | Use the proposed descriptive name and consistent extension namespace. |
| F-7 | Add initially optional Linux Docker/Terraform lifecycle and workflow checks with pinned external tools/providers. | 2026-11-11 | Collect real integration evidence before making those checks mandatory. |

The existing zero-runtime-dependency rule, exact-pinned dev allowlist, compiler
sandbox, signed commits, and `dev` PR target continue to apply. F-3 authorizes the
emulator entry point in the existing host launcher, not arbitrary process
execution. Runtime image references are usable only after their digests and
sources have been recorded. Local AWS requests must never fall back to real AWS.
