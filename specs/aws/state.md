# Queue-only state format v1

This specifies portable data, not process memory. It completes the import and
restart contract in [runtime](runtime.md) before implementation and targeted
independent tests. Every envelope/import fails atomically on invalid data.

## Service document

`StateDocument` for SQS has formatVersion 1, service `sqs`, an account/region scope,
and this data:

```ts
interface QueueState {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly messages: readonly MessageState[];
}
interface MessageState {
  readonly id: string;
  readonly body: string;
  readonly sentAt: number;
  readonly availableAt: number;
  readonly expiresAt: number;
  readonly receiveCount: number;
  readonly firstReceivedAt?: number;
  readonly currentReceipt?: string;
  readonly oldReceipts: readonly string[];
}
// StateDocument.data = { queues: readonly QueueState[] }
```

Names/body/attributes obey the supported SQS operation constraints. Attributes
contain exactly the five effective supported values, including defaults. IDs and
receipts are nonempty opaque strings; constrain their length to 2048 and reject
control characters. Message IDs are unique within each queue; each current/old
receipt is unique across all messages in that queue. Queue names are unique in
the document. No stored endpoint or path is accepted. Reject unknown fields at
every state layer so a future format cannot be silently downgraded.

Times are finite nonnegative integer milliseconds. availableAt >= sentAt;
expiresAt > sentAt and equals sentAt plus the queue retention period. Visibility
may extend beyond retention. receiveCount is a nonnegative safe integer. At count
zero there is no firstReceivedAt/currentReceipt and oldReceipts is empty. At
positive count require firstReceivedAt >= sentAt and a currentReceipt; the number
of distinct old receipts is receiveCount - 1. This subset preserves all known
receipts while their message exists; removing/expiring a message removes them.
Time values do not have to be before the importing machine's current clock.

STS has no mutable Step 1 state: its data is `{}` with the usual service/scope
envelope. Backend imports accept `unknown`, validate the entire replacement, then
swap it in; exports are detached JSON-serializable values.

## Disk envelope and durability

`<stateDirectory>/state.json` contains:

```json
{ "formatVersion": 1, "documents": [] }
```

Each document is a valid service document. Reject duplicate service/account/
region tuples, unknown services/versions/fields and invalid documents before
creating live state. Keep coverage.json separate; it is derived evidence, never
imported as service state. Atomic writes use owned temporary files under the
same root and rename only after a successful complete write. Existing linked or
hardlinked files are rejected before reads/replacement.

Dirty state flushes within one second of a completed mutation under normal local
filesystem conditions; save/shutdown explicitly await flushing. The timer does
not keep an idle stopped process alive. A failed flush stays dirty, reports the
error, and must not replace the last successful state.json with partial bytes.

The exclusive `.lock` file is created with wx and contains a per-start ownership
identifier. Only the instance that created it may release it. A pre-existing
lock always fails clearly; do not infer stale ownership from age. Automatic crash
lock recovery is unsupported in v1 and documented as such. An operator may
remove it after independently ensuring the prior service is stopped. Do not
delete another owner's lock during failed startup cleanup.

## Independent targeted checks

Mutate exported valid documents to test non-finite/fractional times, bad counts,
duplicate queue/message/receipt identities, invalid body/attributes, unknown
fields and cross-scope envelopes. Prove state remains unchanged after rejection.
On disk, reject future version/service documents and old pre-existing locks
without rewriting or deleting them. Observe state.json becoming durable within a
bounded test allowance (four seconds) after mutation without save/close. Place a
linked destination to induce a safe write failure and prove outside bytes remain
unchanged; actual random I/O failures need not be manufactured.
