# Third-party material

MALT's own code is MIT licensed. Third-party material retains its upstream
license. This record supplements the npm policy and image pins in `SECURITY.md`.

## AWS API models

- Source: [aws/api-models-aws](https://github.com/aws/api-models-aws/tree/3cd98287b471c106254abd89279cc87308d38bfd).
- Revision: `3cd98287b471c106254abd89279cc87308d38bfd`.
- Files: STS 2011-06-15 and SQS 2012-11-05 JSON ASTs in `models/aws/`.
- License: Apache-2.0; original [LICENSE](models/aws/LICENSE) and
  [NOTICE](models/aws/NOTICE) are retained without changes.
- Approval: founder decision F-2, 2026-11-11, recorded in
  [the decision log](specs/aws/decisions.md).
- Integrity and upstream paths: `models/aws/sources.json`.

The source files are unmodified. Runtime tables under `src/aws/models/` are
derived by MALT's generator: documentation/client endpoint rules may be omitted,
wire traits and model relationships are retained, keys are sorted and output is
split into linted data files. Generated headers identify the source and license.
The runtime and distribution must retain the AWS license and notice. Model
provenance is not a claim that modeled operations are implemented.

## Smithy protocol cases

- Source: [smithy-lang/smithy](https://github.com/smithy-lang/smithy/tree/e8c7b5f01606f67d5b0fbb76ed761351a6508a3f/smithy-aws-protocol-tests).
- Revision: `e8c7b5f01606f67d5b0fbb76ed761351a6508a3f`.
- Initial sources: the Query and JSON 1.0 empty-input/output case files, under
  `models/aws/protocol-tests/`; filenames are shortened, contents unchanged.
- License: Apache-2.0; original [LICENSE](models/aws/protocol-tests/LICENSE)
  and [NOTICE](models/aws/protocol-tests/NOTICE) retained.
- Same F-2 approval; source paths and checksums are in `models/aws/sources.json`.

Conversions must preserve case IDs, protocol, direction, applies-to restrictions
and request/response data. Report the exact converted cases and tests exercised;
vendoring a test source alone does not establish protocol compliance.

## Imported agent skills

Development-only skills under `.agents/skills/` retain their bundled licenses and
notices. See `.agents/README.md` and `.agents/licenses/` for the imported collection
and provenance limitations. They are not part of the shipped extension/runtime.

## Updating vendored material

Choose an immutable upstream revision, inspect license/notice changes, replace
the approved source bytes, update the SHA-256 inventory, regenerate, and review
the generated diff and tests in a signed PR to `dev`. Generation and drift checks
run offline; builds do not download or execute upstream tools.
