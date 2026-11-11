import assert from 'node:assert/strict';
import { test } from 'node:test';
import { context, ENDPOINT, ESCAPED_BODY, ESCAPED_MD5, evidence, HELLO_MD5, messages, queue, rejectsAws, sqsHarness } from './contract-helpers.mjs';

test(evidence(['sqs.SendMessage', 'sqs.ReceiveMessage'], 'unit', 'independent UTF-8 MD5 vectors preserve exact bodies and unique identities'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h);
  const ids = new Set();
  for (const [body, digest] of [['hello', HELLO_MD5], [ESCAPED_BODY, ESCAPED_MD5]]) {
    const sent = await h.call('SendMessage', { QueueUrl, MessageBody: body });
    assert.equal(sent.MD5OfMessageBody, digest);
    assert.equal(typeof sent.MessageId, 'string');
    assert.ok(sent.MessageId.length > 0);
    assert.ok(!ids.has(sent.MessageId));
    ids.add(sent.MessageId);
    const received = await h.call('ReceiveMessage', { QueueUrl });
    assert.equal(received.Messages.length, 1);
    const [message] = received.Messages;
    assert.equal(message.MessageId, sent.MessageId);
    assert.equal(message.Body, body);
    assert.equal(message.MD5OfBody, digest);
    assert.equal(typeof message.ReceiptHandle, 'string');
    assert.ok(message.ReceiptHandle.length > 0);
    assert.notEqual(message.ReceiptHandle, message.MessageId);
  }
  assert.equal(Object.hasOwn(await h.call('ReceiveMessage', { QueueUrl }), 'Messages'), false);
});

test(evidence(['sqs.SendMessage', 'sqs.ReceiveMessage'], 'unit', 'Unicode code-point validity and byte-size limits are enforced without enqueuing rejected bodies'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h, { Attributes: { MaximumMessageSize: '1024' } });
  for (const body of ['\u0000', '\u0001', '\u000b', '\u001f', '\ufffe', '\uffff', '\ud800', '\udfff', 'a\ud800b']) {
    await rejectsAws(() => h.call('SendMessage', { QueueUrl, MessageBody: body }), { code: 'InvalidMessageContents', statusCode: 400 });
    assert.deepEqual(await h.call('ReceiveMessage', { QueueUrl }), {});
  }
  for (const body of ['', '\u00e9'.repeat(513)]) {
    await rejectsAws(() => h.call('SendMessage', { QueueUrl, MessageBody: body }));
    assert.deepEqual(await h.call('ReceiveMessage', { QueueUrl }), {});
  }
  const valid = '\t\n\r \ud7ff\ue000\ufffd\u{10000}\u{10ffff}';
  await h.call('SendMessage', { QueueUrl, MessageBody: valid });
  assert.equal((await h.call('ReceiveMessage', { QueueUrl })).Messages[0].Body, valid);
  const boundary = await h.call('SendMessage', { QueueUrl, MessageBody: '\u00e9'.repeat(512) });
  assert.equal(boundary.MD5OfMessageBody, '131f9c6222ab6c75193baab1000fb83f');
  const largeUrl = await queue(h, { QueueName: 'OneMiB' });
  assert.equal((await h.call('SendMessage', { QueueUrl: largeUrl, MessageBody: 'x'.repeat(1048576) })).MD5OfMessageBody, 'b561f87202d04959e37588ee05cf5b10');
  await rejectsAws(() => h.call('SendMessage', { QueueUrl: largeUrl, MessageBody: 'x'.repeat(1048577) }));
});

test(evidence(['sqs.SendMessage', 'sqs.ReceiveMessage'], 'unit', 'queue delay and per-message overrides activate exactly at injected deadlines'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h, { Attributes: { DelaySeconds: '2' } });
  await h.call('SendMessage', { QueueUrl, MessageBody: 'default delay' });
  await h.call('SendMessage', { QueueUrl, MessageBody: 'immediate override', DelaySeconds: 0 });
  await h.call('SendMessage', { QueueUrl, MessageBody: 'maximum override', DelaySeconds: 900 });
  assert.equal((await h.call('ReceiveMessage', { QueueUrl })).Messages[0].Body, 'immediate override');
  h.advance(1999);
  assert.deepEqual(await h.call('ReceiveMessage', { QueueUrl }), {});
  h.advance(1);
  assert.equal((await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 43200 })).Messages[0].Body, 'default delay');
  h.advance(897999);
  const available = messages(await h.call('ReceiveMessage', { QueueUrl, MaxNumberOfMessages: 10, VisibilityTimeout: 43200 }));
  assert.deepEqual(available.map((message) => message.Body), ['immediate override']);
  h.advance(1);
  assert.equal((await h.call('ReceiveMessage', { QueueUrl })).Messages[0].Body, 'maximum override');
});

test(evidence(['sqs.ReceiveMessage'], 'unit', 'concurrent receives cannot claim the same invisible delivery and default visibility expires at 30 seconds'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h);
  const sent = await h.call('SendMessage', { QueueUrl, MessageBody: 'hello' });
  const results = await Promise.all(Array.from({ length: 6 }, () => h.call('ReceiveMessage', { QueueUrl })));
  const deliveries = results.flatMap(messages);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].MessageId, sent.MessageId);
  h.advance(29999);
  assert.deepEqual(await h.call('ReceiveMessage', { QueueUrl }), {});
  h.advance(1);
  const redelivered = (await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 0 })).Messages[0];
  assert.equal(redelivered.MessageId, sent.MessageId);
  assert.notEqual(redelivered.ReceiptHandle, deliveries[0].ReceiptHandle);
  assert.equal((await h.call('ReceiveMessage', { QueueUrl })).Messages[0].MessageId, sent.MessageId);
});

test(evidence(['sqs.ReceiveMessage', 'sqs.DeleteMessage'], 'unit', 'superseded receipts succeed without deleting the current delivery; only the latest receipt deletes'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h);
  const sent = await h.call('SendMessage', { QueueUrl, MessageBody: 'hello' });
  const first = (await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 0 })).Messages[0];
  const second = (await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 0 })).Messages[0];
  assert.notEqual(first.ReceiptHandle, second.ReceiptHandle);
  await rejectsAws(() => h.call('DeleteMessage', { QueueUrl, ReceiptHandle: sent.MessageId }), { code: 'ReceiptHandleIsInvalid', statusCode: 404 });
  await rejectsAws(() => h.call('DeleteMessage', { QueueUrl, ReceiptHandle: 'never-issued' }), { code: 'ReceiptHandleIsInvalid' });
  await h.call('DeleteMessage', { QueueUrl, ReceiptHandle: first.ReceiptHandle });
  const third = (await h.call('ReceiveMessage', { QueueUrl })).Messages[0];
  assert.equal(third.MessageId, sent.MessageId);
  assert.notEqual(third.ReceiptHandle, second.ReceiptHandle);
  await h.call('DeleteMessage', { QueueUrl, ReceiptHandle: third.ReceiptHandle });
  h.advance(43200001);
  assert.deepEqual(await h.call('ReceiveMessage', { QueueUrl }), {});
});

test(evidence(['sqs.ReceiveMessage'], 'unit', 'retention starts at send time and expires delayed or invisible messages at the boundary'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h, { Attributes: { MessageRetentionPeriod: '60' } });
  await h.call('SendMessage', { QueueUrl, MessageBody: 'visible' });
  await h.call('SendMessage', { QueueUrl, MessageBody: 'delayed past retention', DelaySeconds: 60 });
  const first = (await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 59 })).Messages[0];
  h.advance(59000);
  assert.equal((await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 0 })).Messages[0].MessageId, first.MessageId);
  h.advance(999);
  assert.equal(messages(await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 0 })).length, 1);
  h.advance(1);
  assert.deepEqual(await h.call('ReceiveMessage', { QueueUrl }), {});
});

test(evidence(['sqs.ReceiveMessage'], 'unit', 'system attributes use original send time stable first-receive time and incremented counts through both request fields'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h);
  const sentAt = h.now();
  await h.call('SendMessage', { QueueUrl, MessageBody: 'hello' });
  h.advance(250);
  const firstAt = h.now();
  const first = (await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 0, MessageSystemAttributeNames: ['All'] })).Messages[0];
  assert.deepEqual(first.Attributes, {
    SenderId: '000000000000', SentTimestamp: String(sentAt), ApproximateFirstReceiveTimestamp: String(firstAt), ApproximateReceiveCount: '1',
  });
  h.advance(125);
  const second = (await h.call('ReceiveMessage', { QueueUrl, AttributeNames: ['ApproximateReceiveCount', 'ApproximateFirstReceiveTimestamp'] })).Messages[0];
  assert.deepEqual(second.Attributes, { ApproximateReceiveCount: '2', ApproximateFirstReceiveTimestamp: String(firstAt) });
});

test(evidence(['sqs.SendMessage', 'sqs.ReceiveMessage'], 'unit', 'unsupported message features and out-of-range numeric controls fail before mutation'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h);
  for (const input of [
    { MessageAttributes: { custom: { DataType: 'String', StringValue: 'x' } } },
    { MessageSystemAttributes: { AWSTraceHeader: { DataType: 'String', StringValue: 'x' } } },
    { MessageGroupId: 'group' }, { MessageDeduplicationId: 'dedup' },
    ...[-1, 901, 1.5].map((DelaySeconds) => ({ DelaySeconds })),
  ]) await rejectsAws(() => h.call('SendMessage', { QueueUrl, MessageBody: 'hello', ...input }));
  assert.deepEqual(await h.call('ReceiveMessage', { QueueUrl }), {});
  await h.call('SendMessage', { QueueUrl, MessageBody: 'hello' });
  for (const input of [
    { ReceiveRequestAttemptId: 'attempt' }, { MessageAttributeNames: ['All'] },
    { MessageSystemAttributeNames: ['SequenceNumber'] },
    ...[0, 11, 1.5].map((MaxNumberOfMessages) => ({ MaxNumberOfMessages })),
    ...[-1, 43201, 1.5].map((VisibilityTimeout) => ({ VisibilityTimeout })),
    ...[-1, 21, 1.5].map((WaitTimeSeconds) => ({ WaitTimeSeconds })),
  ]) await rejectsAws(() => h.call('ReceiveMessage', { QueueUrl, ...input }));
  assert.equal((await h.call('ReceiveMessage', { QueueUrl })).Messages[0].Body, 'hello');
});

test(evidence(['sqs.ReceiveMessage'], 'unit', 'batch count is bounded at ten without losing the remaining available messages'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h);
  for (let index = 0; index < 11; index += 1) await h.call('SendMessage', { QueueUrl, MessageBody: `body-${index}` });
  const first = (await h.call('ReceiveMessage', { QueueUrl, MaxNumberOfMessages: 10 })).Messages;
  const second = (await h.call('ReceiveMessage', { QueueUrl, MaxNumberOfMessages: 10 })).Messages;
  assert.equal(first.length, 10);
  assert.equal(second.length, 1);
  assert.equal(new Set([...first, ...second].map((message) => message.MessageId)).size, 11);
});

test(evidence(['sqs.SendMessage', 'sqs.ReceiveMessage', 'sqs.DeleteMessage', 'sqs.DeleteQueue'], 'unit', 'QueueUrl origin path scope and receipt ownership cannot alias another queue'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h);
  await h.call('SendMessage', { QueueUrl, MessageBody: 'hello' });
  const first = (await h.call('ReceiveMessage', { QueueUrl, VisibilityTimeout: 0 })).Messages[0];
  for (const caller of [context({ region: 'eu-west-1' }), context({ account: '111122223333' })]) {
    const local = await queue(h, {}, caller);
    for (const operation of ['SendMessage', 'ReceiveMessage', 'DeleteMessage', 'DeleteQueue']) {
      const input = { QueueUrl, ...(operation === 'SendMessage' ? { MessageBody: 'intruder' } : {}),
        ...(operation === 'DeleteMessage' ? { ReceiptHandle: first.ReceiptHandle } : {}) };
      await rejectsAws(() => h.call(operation, input, caller));
    }
    await rejectsAws(() => h.call('DeleteMessage', { QueueUrl: local, ReceiptHandle: first.ReceiptHandle }, caller), { code: 'ReceiptHandleIsInvalid' });
  }
  const sibling = await queue(h, { QueueName: 'Sibling' });
  await rejectsAws(() => h.call('DeleteMessage', { QueueUrl: sibling, ReceiptHandle: first.ReceiptHandle }), { code: 'ReceiptHandleIsInvalid' });
  for (const url of [QueueUrl.replace(ENDPOINT, 'http://127.0.0.1:1'), QueueUrl.replace('http:', 'https:'),
    QueueUrl.replace('/Synthetic_queue-1', '/wrong/Synthetic_queue-1'), `${QueueUrl}/extra`, `${QueueUrl}?alias=1`,
    QueueUrl.replace('127.0.0.1', 'user@127.0.0.1')]) {
    await rejectsAws(() => h.call('SendMessage', { QueueUrl: url, MessageBody: 'intruder' }));
  }
  assert.equal((await h.call('ReceiveMessage', { QueueUrl })).Messages[0].MessageId, first.MessageId);
});
