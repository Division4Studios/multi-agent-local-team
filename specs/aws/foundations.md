# AWS foundations: models and credential routing

Depends on [compatibility](compatibility.md) and approved F-1/F-2 in
[decisions](decisions.md). Expected results derive from the references below,
not from implementation output.

## Model generator

Vendor STS and SQS JSON AST files unmodified from `aws/api-models-aws` commit
`3cd98287b471c106254abd89279cc87308d38bfd`:

- `models/sts/service/2011-06-15/sts-2011-06-15.json`
- `models/sqs/service/2012-11-05/sqs-2012-11-05.json`

Retain upstream LICENSE/NOTICE. Record source URLs, revisions and SHA-256 file
digests in `models/aws/sources.json` and explain updates in `THIRD_PARTY.md`.
Smithy protocol cases use commit `e8c7b5f01606f67d5b0fbb76ed761351a6508a3f` of
`smithy-lang/smithy`. Vendor only the cases currently consumed; retain their
original source and describe any conversion explicitly.

`scripts/aws-models.mts` is an offline build-time command. It produces committed
data-only TypeScript under `src/aws/models/<service>/`. It must:

1. Validate the JSON AST, including service selection, shape IDs, operation and
   member references, and required model fields; reject malformed input rather
   than silently omitting referenced shapes or operations.
2. Preserve each service's version, signing name, protocol traits and XML
   namespace, plus operations' names, inputs, outputs, errors and HTTP traits.
3. Preserve shape kinds, enums, required members, targets, and wire/validation
   traits (including names, flattened lists/maps, timestamp formats, HTTP
   labels/query/header/payload, defaults and constraints). Documentation prose
   may be removed from generated runtime tables, not from source files.
4. Produce deterministic output independent of input object-key order. Generate
   no executable handlers or dynamic expressions; JSON string escaping must
   safely handle quotes, newlines and hostile source strings.
5. Split generated files below 400 non-comment/non-blank lines and lint them
   normally. Generator and hand-written modules obey all existing limits.
6. Regenerate without network access or installed Smithy tools. A `--check` mode
   compares the complete generated file set and content, failing on missing,
   modified, or stale generated files. Check mode must not modify files.

Public generator API (for independent unit tests):

```ts
// scripts/aws-model-data.mts
export const generateModelFiles = (
  input: unknown,
  signingName: string,
): ReadonlyMap<string, string>;
```

Returned paths are relative to that service's output directory, using safe
fixed filenames. Values are complete TypeScript source. Invalid models or an
unknown/ambiguous signing service throw an explanatory Error. A small original
synthetic Smithy AST is a sufficient unit-test oracle; real vendored models
provide integration and drift coverage. Every operation is present regardless
of whether it has a handler yet.

## Credential scope parser

`src/shared/aws/sigv4.ts` provides a pure boundary parser:

```ts
interface SigningScope {
  readonly accessKeyId: string;
  readonly date: string;
  readonly region: string;
  readonly service: string;
}
export const parseSigningScope = (
  authorization: string | undefined,
  rawTarget: string,
): SigningScope | undefined;
```

Read `Credential=<key>/<YYYYMMDD>/<region>/<service>/aws4_request` from an
`AWS4-HMAC-SHA256` Authorization header. Header fields use comma separation;
accept ordinary surrounding horizontal whitespace. Require exactly one each of
Credential, SignedHeaders and Signature; reject duplicated/unknown attributes,
empty values, malformed scope and other signing algorithms. SignedHeaders must
be semicolon-separated lowercase HTTP header names; Signature must contain 64
hexadecimal characters. This checks syntax, not signature validity or date age.

When Authorization is absent, read query-auth fields from the query substring
of the original target (never run the target through URL path normalization).
Require exactly one each of X-Amz-Algorithm, X-Amz-Credential,
X-Amz-SignedHeaders and X-Amz-Signature, with the same algorithm/field syntax.
Other ordinary request/presign parameters may be present. Decode query names
and values once using strict percent decoding; reject malformed encoding or
duplicates of authentication fields. A malformed present Authorization header
must not fall back to query authentication. Reject a request mixing header and
query authentication instead of choosing conflicting credentials.

Credential components must be nonempty, with an alphanumeric access key
(including `test`), eight decimal date digits, lowercase alphanumeric/hyphen
region/service components, and the exact terminal `aws4_request`. Do not require
a known AWS region, actual current date, or live access key. Parsing never
mutates the raw request target. The parser returns `undefined` on invalid input;
the gateway later maps that to its explanatory 403.

## Verification

- Independently authored Node tests for a small synthetic model: metadata,
  operation/error reachability, wire traits, malformed models/references,
  stable generation, safe escaping, and file-size splitting.
- SigV4 tests: documented header/presign forms, arbitrary regions, local test
  credentials, malformed/ambiguous inputs, and raw S3 target preservation.
- Real STS/SQS generation, regenerate-and-diff, existing strict type/lint gates,
  service-import restriction checks, and precise VSIX packaging.

## Sources

- [Smithy JSON AST](https://smithy.io/2.0/spec/json-ast.html)
- [Smithy AWS protocols](https://smithy.io/2.0/aws/protocols/index.html)
- [AWS credential scope and Authorization syntax](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html)
- [S3 presigned URL authentication](https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html)
