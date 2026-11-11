# STS GetCallerIdentity

Sources: [AWS operation reference](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetCallerIdentity.html),
the pinned `models/aws/sts.json`, and [local compatibility](../compatibility.md).

## Request and response

AWS Query version `2011-06-15`, `Action=GetCallerIdentity`, with no operation
parameters. Read the caller resolved from the signing access key; return the
caller's `Account`, `Arn`, and `UserId` inside `GetCallerIdentityResult`, with
`ResponseMetadata/RequestId` and namespace
`https://sts.amazonaws.com/doc/2011-06-15/`.

The initial default local root identity is account `000000000000`, ARN
`arn:aws:iam::000000000000:root`, and UserId `000000000000`. Resolve identity in
the shared identity boundary, not by trusting caller-supplied body fields.
GetCallerIdentity requires no permission, even with an explicit identity-policy
deny, as AWS documents. Authentication syntax and local identity resolution
still apply. Trace both the caller and this documented permission exemption.

## Initial limits

The first milestone exposes the default local account/root identity only.
Temporary credentials and user/role creation arrive with IAM/STS in Step 2.
Other modeled STS operations return explicit unsupported errors containing their
operation names. Unknown operations also fail; they never synthesize identities.
Until temporary identities exist, coverage must describe the root-only subset.

## Acceptance

- Signed form POST and presigned query GET return the same local root identity.
- Missing/malformed signature scope produces the gateway's explanatory 403.
- Query XML uses the model namespace, escaped text and a per-request ID.
- Each other operation in the pinned STS model receives an asserted unsupported
  response; no call is forwarded to AWS.
