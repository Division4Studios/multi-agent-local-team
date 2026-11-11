# Runtime and acceptance-tool image pins

Resolved on 2026-11-11 using `docker buildx imagetools inspect <tag>` against the
named registries. F-5 approves the runtime versions; F-7 permits external
integration tooling. Digests below are observed registry manifests, not claims
that runtime invocation or database compatibility has passed.

## Approved runtime defaults

| Runtime | Immutable multi-platform reference |
| --- | --- |
| Lambda nodejs22.x | `public.ecr.aws/lambda/nodejs:22@sha256:82a1074ccdc85eb4f0d1deac6f3b8f825aee1f4d6eda62df76280669704a7851` |
| Lambda python3.13 | `public.ecr.aws/lambda/python:3.13@sha256:d0acb0bce6c7b14a193a911f800bee8ff73fd28bc8d01e953db2f5aea32d270e` |
| PostgreSQL 17 | `docker.io/library/postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f` |

Observed architecture manifests:

| Runtime | Linux amd64 | Linux arm64/v8 |
| --- | --- | --- |
| Node.js Lambda | `sha256:a51a8762e2c0679126e224db8ae95ea3aeb9222da35e774b5677396b7e770bfd` | `sha256:9bca076466735065fea2a5621708feb2cfe476571c301d6efadfc6dbb91fe685` |
| Python Lambda | `sha256:433db4c37d96fe4156b0b72fc1e61803dbc9caf146931d4df72c727912ee4972` | `sha256:33592a86307f3d57fab3902a9fa14a578777207871f05e3c3577e1754fb75742` |
| PostgreSQL | `sha256:996e9dc583ba9f0265a2c75547a9c95fb22c251e394749cab205a0a00e1856a1` | `sha256:f998bd5067cabb2b023800c6fbf04f24bd22fbb7f8430cfd8c8503a6c3834777` |

The PostgreSQL manifest reports version 17.11 and source
`docker-library/postgres@2603e26e245e558218728ee14e0a42dcb020dc7f`, `17/trixie`.
Lambda/PostgreSQL implementation remains subject to the Step 2 placement revisit.

The gateway reuses MALT's already pinned Node image:
`node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`.

## External acceptance clients

- AWS CLI 2.40.1:
  `public.ecr.aws/aws-cli/aws-cli:2.40.1@sha256:4ade0fe3e60e0b9e1fb0910f86c6d992baf4e12d3172c25a3c8c11f6c81cee08`.
  Linux amd64 manifest: `sha256:05c4801c0499448f07f05691e76c2a3e53a2049e0e801336d5655b080f3e0a2f`;
  arm64: `sha256:3485c43c58e6106e2191c25b4afd77a28c2dc755a615fea979f58de3820880a6`.
  Upstream tag resolves to `aws/aws-cli@73b1a02188f5b68e8018852f6d6931ffd95c8337`.
- Python acceptance-client base:
  `docker.io/library/python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90`.
  Manifest reports 3.13.18-slim-trixie; source
  `docker-library/python@152874b138f0b1c4699fbdcb52b174608cfbfff5`.
- Boto3 1.44.0 is the selected SDK version, observed in PyPI metadata. Its entire
  external client dependency closure and hashes must be pinned before building
  the acceptance image. This is test tooling, not a MALT package dependency.

Record pull/build/run results separately when the gateway is available. Updating
these pins requires new observed digests and a reviewed change; never silently
fall back to a mutable tag if a digest cannot be pulled.
