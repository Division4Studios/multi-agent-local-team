# SQS walking skeleton: standard queues and message visibility

Sources: the pinned `models/aws/sqs.json`, [local compatibility](../compatibility.md),
and the AWS operation references linked below. This milestone implements a
declared standard-queue subset and reports its limits, rather than accepting
unimplemented configuration.

## Queue operations

### CreateQueue

[Reference](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_CreateQueue.html).
Require `QueueName`: 1–80 ASCII alphanumeric, underscore or hyphen characters.
Names are case-sensitive and isolated by account and region. Initially support
`VisibilityTimeout` (0–43200 seconds, default 30), `DelaySeconds` (0–900, default
0), `MessageRetentionPeriod` (60–1209600, default 345600),
`MaximumMessageSize` (1024–1048576, default 1048576), and
`ReceiveMessageWaitTimeSeconds` (0–20, default 0). Attribute values are decimal
strings. Invalid names/values fail with the documented typed error.

Repeated creation with the same effective settings returns the existing URL;
conflicting settings return `QueueNameExists`. FIFO, redrive, policy, encryption,
and tags are explicitly unsupported in this slice. Never accept and ignore them.
Queue URLs identify account, region and case-sensitive name, using the
configured local gateway origin (including an ephemeral test port).

AWS's one-second create readiness and sixty-second recreation delay may be
accelerated locally, but this deviation must appear in generated coverage.

### GetQueueUrl

[Reference](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_GetQueueUrl.html).
Return the canonical local URL for QueueName in the caller's account/region.
An explicit QueueOwnerAWSAccountId may only address the caller's own account in
the initial subset; other-account access fails, not aliases a same-named queue.
Missing queues return `QueueDoesNotExist`; its Query wire code comes from the
model (`AWS.SimpleQueueService.NonExistentQueue`).

### DeleteQueue

[Reference](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_DeleteQueue.html).
Require a queue URL owned by the current scope. Remove queue/messages/receipts.
The JSON operation has unit output (empty body with protocol content type).
The Query response still carries operation response metadata. Subsequent lookup
or message calls fail as missing queues. Do not make network requests to QueueUrl.

## Message operations

### SendMessage

[Reference](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessage.html).
Require QueueUrl and MessageBody. Preserve body text exactly and compute the MD5
over its UTF-8 bytes; return MessageId and MD5OfMessageBody. Enforce nonempty body,
the queue byte limit and the documented allowed Unicode code points: tab, LF,
CR, U+0020–D7FF, U+E000–FFFD, U+10000–10FFFF; reject unpaired surrogates.
An optional DelaySeconds overrides the queue delay (integer 0–900). Delayed
messages remain unavailable until their deadline. Retention starts at send time.
Message attributes/system attributes, FIFO/group/deduplication fields are
explicitly unsupported in this first subset, not silently discarded.

### ReceiveMessage

[Reference](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ReceiveMessage.html).
MaxNumberOfMessages is integer 1–10 (default 1). VisibilityTimeout is integer
0–43200, defaulting to the queue setting. WaitTimeSeconds is integer 0–20,
defaulting to the queue setting. Return available unexpired messages, up to the
requested count, with exact Body, MD5OfBody, MessageId and a new ReceiptHandle
on each receive. Set visibility deadlines before completing the call so
concurrent receives cannot claim the same still-invisible delivery.

Empty short polls omit Messages. A long poll returns when a message becomes
available or its timeout elapses; it must also respond to newly sent messages,
visibility expiry, queue deletion and service shutdown. Tests use injected clocks
for synchronous state transitions and bounded real timers for HTTP long polling.
The deterministic local polling order is a documented simulation, not AWS
ordering or probabilistic short-poll sampling fidelity.

Support requested standard system attributes (`All`, SenderId, SentTimestamp,
ApproximateFirstReceiveTimestamp, ApproximateReceiveCount) through either the
current or deprecated request field; do not invent unsupported attribute values.
FIFO receive-attempt IDs and custom message-attribute selections are explicitly
unsupported for now. Expired retention removes the message before a receive.

### DeleteMessage

[Reference](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_DeleteMessage.html).
Require QueueUrl and the receipt for the latest delivery, not MessageId. A valid
current receipt removes the message. A receipt unknown to that queue/scope fails
with ReceiptHandleIsInvalid. AWS documents that an older receipt may succeed
without deleting: emulate that permitted outcome for known superseded receipts,
and prove it cannot delete the current delivery. Never accept receipts across
queues, regions or accounts. JSON unit output is an empty body; Query includes
response metadata. Document that distributed duplicate-after-delete behavior
is not simulated yet.

## Protocols and unsupported behavior

Accept JSON 1.0 (`AmazonSQS.<Operation>`) and legacy AWS Query version 2012-11-05.
Use model shapes/traits for field names, required fields, flattened list/map
bindings and error codes. Legacy queue operations can identify the queue through
the URL path as well as QueueUrl; reject conflicting identities. JSON and Query
calls share the same backend state. Reject unknown body members and unsupported
feature fields explicitly; never return success while ignoring their meaning.

Every other operation in the 23-operation pinned SQS model returns an AWS-shaped
unsupported error naming the operation. This includes batch calls, permissions,
queue attribute mutation, tags, purge and message-move APIs. GetQueueAttributes
and ListQueues are not implied by a resources UI; admin inventory is separate.

## State and evidence

Export/import versioned service documents by account/region, including queue
definitions, bodies, send/visibility/retention times and receipt metadata needed
to preserve supported behavior. Parse the complete document before replacing
state; malformed/unknown-version imports leave existing state intact. Reset can
target one scope or all. Request, policy and state traces exclude message bodies,
raw Authorization values, session tokens and receipts.

Prove normal JSON/Query round trips, missing resources, boundary values, invalid
Unicode, conflicting creates, delayed/hidden/expired messages, fresh versus stale
receipts, cross-scope denial, persistence/restart, reset and every unsupported
operation. Coverage stays `partial` with the limits above even when all tests for
this subset pass. Generated evidence lists executed test kinds, not full-service
compatibility. AWS CLI plus one SDK must pass a real local round trip.
