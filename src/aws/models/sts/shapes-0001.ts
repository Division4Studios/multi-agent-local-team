// Source: aws/api-models-aws@3cd98287b471c106254abd89279cc87308d38bfd/models/sts/service/2011-06-15/sts-2011-06-15.json
// SHA-256: 794c8b2142e3a65bc6cc7922005eb85d6b71b02353fef03c0f395e8f902ee2d0
// Generated Smithy model data; do not edit. See THIRD_PARTY.md and models/aws/sources.json.
// AWS source models: Apache-2.0, models/aws/LICENSE and models/aws/NOTICE.
import type { ShapeTable } from '../model';

export const shapes0001: ShapeTable = {
  "com.amazonaws.sts#tagValueType": { "traits": { "smithy.api#length": { "max": 256, "min": 0 }, "smithy.api#pattern": "^[\\p{L}\\p{Z}\\p{N}_.:/=+\\-@]*$" }, "type": "string" },
  "com.amazonaws.sts#tokenCodeType": { "traits": { "smithy.api#length": { "max": 6, "min": 6 }, "smithy.api#pattern": "^[\\d]*$" }, "type": "string" },
  "com.amazonaws.sts#tokenType": { "traits": {  }, "type": "string" },
  "com.amazonaws.sts#tradeInTokenType": { "traits": { "smithy.api#sensitive": {  } }, "type": "string" },
  "com.amazonaws.sts#unrestrictedSessionPolicyDocumentType": { "traits": { "smithy.api#length": { "min": 1 }, "smithy.api#pattern": "^[\\u0009\\u000A\\u000D\\u0020-\\u00FF]+$" }, "type": "string" },
  "com.amazonaws.sts#urlType": { "traits": { "smithy.api#length": { "max": 2048, "min": 4 } }, "type": "string" },
  "com.amazonaws.sts#userIdType": { "traits": {  }, "type": "string" },
  "com.amazonaws.sts#userNameType": { "traits": { "smithy.api#length": { "max": 32, "min": 2 }, "smithy.api#pattern": "^[\\w+=,.@-]*$" }, "type": "string" },
  "com.amazonaws.sts#webIdentitySubjectType": { "traits": { "smithy.api#length": { "max": 255, "min": 6 } }, "type": "string" },
  "com.amazonaws.sts#webIdentityTokenAudienceListType": { "member": { "target": "com.amazonaws.sts#webIdentityTokenAudienceStringType", "traits": {  } }, "traits": { "smithy.api#length": { "max": 10, "min": 1 } }, "type": "list" },
  "com.amazonaws.sts#webIdentityTokenAudienceStringType": { "traits": { "smithy.api#length": { "max": 1000, "min": 1 } }, "type": "string" },
  "com.amazonaws.sts#webIdentityTokenDurationSecondsType": { "traits": { "smithy.api#range": { "max": 3600, "min": 60 } }, "type": "integer" },
  "com.amazonaws.sts#webIdentityTokenType": { "traits": { "smithy.api#sensitive": {  } }, "type": "string" },
};
