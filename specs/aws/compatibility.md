# Local AWS compatibility contract

Status: implementation specification for issue [#62](https://github.com/Division4Studios/multi-agent-local-team/issues/62).
Founder choices: [decisions](decisions.md). This file describes the intended
contract; test evidence, not this specification, determines implementation status.

## External contract

| Item | Contract |
| --- | --- |
| Gateway | Plain HTTP, `127.0.0.1:4566` by default. Wider binding requires an explicit setting and warning. Tests may bind port zero. |
| TCP backends | Loopback ports 4510–4559. |
| Credentials | Local convention `test` / `test`; syntactically valid SigV4 credentials are parsed, not cryptographically verified by default. |
| Default identity | Account `000000000000`, root ARN `arn:aws:iam::000000000000:root`; trace default/root use explicitly. |
| Scope | Arbitrary signing regions, `us-east-1` convention; state isolation by account and region. |
| Tool endpoints | `AWS_ENDPOINT_URL` and `AWS_ENDPOINT_URL_<SERVICE>`, including S3. |
| Routing | Authorization credential scope or presigned `X-Amz-Credential`, then protocol headers, host, and path. Unsigned AWS API calls receive an explanatory 403. |
| Paths | Preserve request-target bytes/text, including S3 repeated slashes, dot segments, percent encodings, and literal plus signs. Never route by a normalized S3 URL. |
| Health | Unauthenticated `GET /_health`: `{ "status": "running", "services": {...} }`. |
| Unsupported | Protocol-appropriate AWS error naming the operation and stating that it is unsupported; no fake successful mutation. |
| Admin | Separate random loopback listener, per-start bearer token, parsed JSON boundary, no token/credential logging. |
| Hot reload | `S3Bucket="hot-reload"`, absolute host path in `S3Key`, contained read-only `/var/task` mount. |

## Supported protocol introduction

Initial service models: STS (2011-06-15) and SQS (2012-11-05). Their pinned models
are authoritative for shapes, service signing names, operation names, and
protocol traits. Initial codecs implement AWS Query and AWS JSON 1.0. Later
REST-JSON/REST-XML/JSON 1.1 support must have its own sourced cases. A protocol or
binding not implemented by a codec must produce an explicit error.

The raw request target and body are captured before decoding. Gateway dispatch
resolves one caller/scope, one modeled operation, one typed input, and one policy
decision. Internal errors expose a trace reference, never a stack. Public health
is deliberately exempt from AWS authentication; admin routes use their own token.

## Coverage and test evidence

Per modeled operation, report `unsupported`, `stubbed`, `partial`, `verified`, or
`simulated`, the actual test kinds and known limitations. Generate reports from
operation declarations plus successful test evidence, not a hand-maintained
claim list. Each modeled but unimplemented operation must have an unsupported
error assertion. Incomplete service subsets remain visibly partial.

Tests are authored from these specifications and external references before
implementation. Protocol fixtures originate from pinned upstream cases or
documented original synthetic examples. Do not run differential tests against
real AWS automatically. SDK/CLI integration probes must explicitly select the
local endpoint, local credentials, and disable instance-metadata credentials.

## Sources

- [AWS endpoint configuration](https://docs.aws.amazon.com/sdkref/latest/guide/feature-ss-endpoints.html)
- [SigV4 request construction](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html)
- [Smithy AWS protocols](https://smithy.io/2.0/aws/protocols/index.html)
- [AWS API models](https://github.com/aws/api-models-aws)
- [STS GetCallerIdentity](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html)
- [SQS CreateQueue, including both protocol examples](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_CreateQueue.html)
