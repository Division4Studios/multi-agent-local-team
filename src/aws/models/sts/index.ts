// Source: aws/api-models-aws@3cd98287b471c106254abd89279cc87308d38bfd/models/sts/service/2011-06-15/sts-2011-06-15.json
// SHA-256: 794c8b2142e3a65bc6cc7922005eb85d6b71b02353fef03c0f395e8f902ee2d0
// Generated Smithy model data; do not edit. See THIRD_PARTY.md and models/aws/sources.json.
// AWS source models: Apache-2.0, models/aws/LICENSE and models/aws/NOTICE.
import type { ServiceModel } from '../model';
import { catalog0Group0 } from './catalog-0-0000';

export const model: ServiceModel = {
  smithy: "2.0",
  serviceId: "com.amazonaws.sts#AWSSecurityTokenServiceV20110615",
  signingName: "sts",
  service: { "errors": [], "operations": [{ "target": "com.amazonaws.sts#AssumeRole" }, { "target": "com.amazonaws.sts#AssumeRoleWithSAML" }, { "target": "com.amazonaws.sts#AssumeRoleWithWebIdentity" }, { "target": "com.amazonaws.sts#AssumeRoot" }, { "target": "com.amazonaws.sts#DecodeAuthorizationMessage" }, { "target": "com.amazonaws.sts#GetAccessKeyInfo" }, { "target": "com.amazonaws.sts#GetCallerIdentity" }, { "target": "com.amazonaws.sts#GetDelegatedAccessToken" }, { "target": "com.amazonaws.sts#GetFederationToken" }, { "target": "com.amazonaws.sts#GetSessionToken" }, { "target": "com.amazonaws.sts#GetWebIdentityToken" }], "rename": {  }, "resources": [], "traits": { "aws.api#service": { "arnNamespace": "sts", "cloudFormationName": "STS", "cloudTrailEventSource": "sts.amazonaws.com", "endpointPrefix": "sts", "sdkId": "STS" }, "aws.auth#sigv4": { "name": "sts" }, "aws.auth#sigv4a": { "name": "sts" }, "aws.protocols#awsQuery": {  }, "smithy.api#auth": ["aws.auth#sigv4", "aws.auth#sigv4a"], "smithy.api#title": "AWS Security Token Service", "smithy.api#xmlNamespace": { "uri": "https://sts.amazonaws.com/doc/2011-06-15/" } }, "type": "service", "version": "2011-06-15" },
  shapes: catalog0Group0,
};
