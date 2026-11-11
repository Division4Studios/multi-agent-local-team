// Source: aws/api-models-aws@3cd98287b471c106254abd89279cc87308d38bfd/models/sqs/service/2012-11-05/sqs-2012-11-05.json
// SHA-256: f34a7d2560fb9776206fb35958b8d0fc5f17d33f377bb7512d55a34a8c0c78f0
// Generated Smithy model data; do not edit. See THIRD_PARTY.md and models/aws/sources.json.
// AWS source models: Apache-2.0, models/aws/LICENSE and models/aws/NOTICE.
import type { ServiceModel } from '../model';
import { catalog0Group0 } from './catalog-0-0000';

export const model: ServiceModel = {
  smithy: "2.0",
  serviceId: "com.amazonaws.sqs#AmazonSQS",
  signingName: "sqs",
  service: { "errors": [], "operations": [{ "target": "com.amazonaws.sqs#AddPermission" }, { "target": "com.amazonaws.sqs#CancelMessageMoveTask" }, { "target": "com.amazonaws.sqs#ChangeMessageVisibility" }, { "target": "com.amazonaws.sqs#ChangeMessageVisibilityBatch" }, { "target": "com.amazonaws.sqs#CreateQueue" }, { "target": "com.amazonaws.sqs#DeleteMessage" }, { "target": "com.amazonaws.sqs#DeleteMessageBatch" }, { "target": "com.amazonaws.sqs#DeleteQueue" }, { "target": "com.amazonaws.sqs#GetQueueAttributes" }, { "target": "com.amazonaws.sqs#GetQueueUrl" }, { "target": "com.amazonaws.sqs#ListDeadLetterSourceQueues" }, { "target": "com.amazonaws.sqs#ListMessageMoveTasks" }, { "target": "com.amazonaws.sqs#ListQueues" }, { "target": "com.amazonaws.sqs#ListQueueTags" }, { "target": "com.amazonaws.sqs#PurgeQueue" }, { "target": "com.amazonaws.sqs#ReceiveMessage" }, { "target": "com.amazonaws.sqs#RemovePermission" }, { "target": "com.amazonaws.sqs#SendMessage" }, { "target": "com.amazonaws.sqs#SendMessageBatch" }, { "target": "com.amazonaws.sqs#SetQueueAttributes" }, { "target": "com.amazonaws.sqs#StartMessageMoveTask" }, { "target": "com.amazonaws.sqs#TagQueue" }, { "target": "com.amazonaws.sqs#UntagQueue" }], "rename": {  }, "resources": [], "traits": { "aws.api#service": { "arnNamespace": "sqs", "cloudFormationName": "SQS", "cloudTrailEventSource": "sqs.amazonaws.com", "endpointPrefix": "sqs", "sdkId": "SQS" }, "aws.auth#sigv4": { "name": "sqs" }, "aws.protocols#awsJson1_0": {  }, "aws.protocols#awsQueryCompatible": {  }, "smithy.api#title": "Amazon Simple Queue Service" }, "type": "service", "version": "2012-11-05" },
  shapes: catalog0Group0,
};
