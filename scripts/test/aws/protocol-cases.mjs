// Precisely selected upstream properties, converted to the real STS/SQS gateway.
// No claim of executing the upstream synthetic services or client-only cases.
const revision = 'e8c7b5f01606f67d5b0fbb76ed761351a6508a3f';
export const protocolSources = {
  query: {
    repository: 'smithy-lang/smithy', revision,
    file: 'protocol-tests/awsQuery-empty.smithy',
    path: 'smithy-aws-protocol-tests/model/awsQuery/empty-input-output.smithy',
    sha256: '4adf01d345897af60d288129203f8d1eff780c41cf7ba52ff3ba0b29700c8718',
  },
  json: {
    repository: 'smithy-lang/smithy', revision,
    file: 'protocol-tests/awsJson1_0-empty.smithy',
    path: 'smithy-aws-protocol-tests/model/awsJson1_0/empty-input-output.smithy',
    sha256: '5cafc783615109769ad018c208aa25c4bc0945a3bb68158cfcdb446b1e84195c',
  },
};

export const selectedCases = [
  { source: 'query', id: 'QueryNoInputAndOutput', trait: 'httpRequestTests', operation: 'NoInputAndOutput', appliesTo: null,
    adaptation: 'Substitute GetCallerIdentity and STS version for the empty modeled input; sign the exact Action/Version-only form.' },
  { source: 'query', id: 'QueryNoInputAndNoOutputWithResponseMetadata', trait: 'httpResponseTests', operation: 'NoInputAndNoOutput', appliesTo: null,
    adaptation: 'Use DeleteQueue and DeleteMessage Unit outputs; substitute wrapper name, namespace and live matching RequestId.' },
  { source: 'json', id: 'AwsJson10ServiceRespondsWithNoPayload', trait: 'httpResponseTests', operation: 'NoInputAndNoOutput', appliesTo: null,
    adaptation: 'Use SQS DeleteQueue and DeleteMessage Unit outputs; require exactly zero body bytes and JSON 1.0 Content-Type.' },
  { source: 'json', id: 'AwsJson10EmptyInputAndEmptyOutputSendJsonObject', trait: 'httpResponseTests', operation: 'EmptyInputAndEmptyOutput', appliesTo: null,
    adaptation: 'Use empty ReceiveMessage modeled structure output: optional Messages omitted, JSON object {} still serialized.' },
];
