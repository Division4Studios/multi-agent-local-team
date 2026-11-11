import assert from 'node:assert/strict';
import { test } from 'node:test';
import { context, ENDPOINT, evidence, IMPLEMENTED, models, queue, rejectsAws, sqsHarness, stsBackend } from './contract-helpers.mjs';

test(evidence(['sts.GetCallerIdentity'], 'unit', 'resolved default root identity has exact Account Arn and UserId'), async () => {
  const backend = stsBackend();
  assert.deepEqual(await backend.handle({ operation: 'GetCallerIdentity', input: {} }, context()), {
    Account: '000000000000', Arn: 'arn:aws:iam::000000000000:root', UserId: '000000000000',
  });
});

for (const service of ['sts', 'sqs']) {
  test(`${service} public operation declarations exactly cover the pinned model and keep implemented subsets partial`, () => {
    const backend = service === 'sqs' ? sqsHarness().backend : stsBackend();
    assert.equal(backend.service, service);
    assert.deepEqual([...backend.operations.keys()].sort(), models[service].operations);
    for (const [operation, support] of backend.operations) {
      assert.equal(support.status, IMPLEMENTED[service].includes(operation) ? 'partial' : 'unsupported', operation);
      assert.ok(Array.isArray(support.limitations));
      if (IMPLEMENTED[service].includes(operation)) assert.ok(support.limitations.length > 0, `${service}.${operation} must explain its limitation`);
      assert.ok(support.limitations.every((item) => typeof item === 'string' && item.length > 0));
    }
  });

  for (const operation of models[service].operations.filter((name) => !IMPLEMENTED[service].includes(name))) {
    test(evidence([`${service}.${operation}`], 'unit', 'pinned modeled operation rejects with named UnsupportedOperation'), async () => {
      const backend = service === 'sqs' ? sqsHarness().backend : stsBackend();
      await rejectsAws(() => backend.handle({ operation, input: {} }, context()), {
        code: 'UnsupportedOperation', statusCode: 400, message: new RegExp(`(?=.*${service})(?=.*${operation})`, 'isu'),
      });
    });
  }

  test(`${service} unknown operation cannot synthesize a successful response`, async () => {
    const backend = service === 'sqs' ? sqsHarness().backend : stsBackend();
    await rejectsAws(() => backend.handle({ operation: 'SyntheticUnknownOperation', input: {} }, context()));
  });
}

test(evidence(['sqs.CreateQueue', 'sqs.GetQueueUrl'], 'unit', 'case-sensitive names and account-region scopes have independent canonical URLs'), async () => {
  const h = sqsHarness();
  const scopes = [context(), context({ region: 'eu-west-1' }), context({ account: '111122223333' })];
  for (const caller of scopes) {
    const url = await queue(h, { QueueName: 'Case_sensitive-123' }, caller);
    assert.equal(url, `${ENDPOINT}/${caller.account}/${caller.region}/Case_sensitive-123`);
    assert.deepEqual(await h.call('GetQueueUrl', { QueueName: 'Case_sensitive-123' }, caller), { QueueUrl: url });
    assert.deepEqual(await h.call('GetQueueUrl', { QueueName: 'Case_sensitive-123', QueueOwnerAWSAccountId: caller.account }, caller), { QueueUrl: url });
    await rejectsAws(() => h.call('GetQueueUrl', { QueueName: 'case_sensitive-123' }, caller), { code: 'QueueDoesNotExist' });
  }
  await rejectsAws(() => h.call('GetQueueUrl', { QueueName: 'Case_sensitive-123', QueueOwnerAWSAccountId: '111122223333' }));
  await rejectsAws(() => h.call('GetQueueUrl', { QueueName: 'absent' }), { code: 'QueueDoesNotExist', statusCode: 400 });
});

test(evidence(['sqs.CreateQueue'], 'unit', 'effective defaults are idempotent and conflicting settings have the modeled error'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h);
  assert.equal(await queue(h), QueueUrl);
  assert.equal(await queue(h, { Attributes: {
    VisibilityTimeout: '30', DelaySeconds: '0', MessageRetentionPeriod: '345600',
    MaximumMessageSize: '1048576', ReceiveMessageWaitTimeSeconds: '0',
  } }), QueueUrl);
  await rejectsAws(() => queue(h, { Attributes: { VisibilityTimeout: '31' } }), { code: 'QueueNameExists', statusCode: 400 });
});

test(evidence(['sqs.CreateQueue', 'sqs.GetQueueUrl'], 'unit', 'name and attribute boundaries reject before creating a queue'), async () => {
  const h = sqsHarness();
  for (const name of ['A', 'Z'.repeat(80), 'a-z_09']) assert.ok(await queue(h, { QueueName: name }));
  for (const name of ['', 'z'.repeat(81), 'space name', 'caf\u00e9', '../escape', 'a/b', 'a.b', 'line\nbreak']) {
    await rejectsAws(() => queue(h, { QueueName: name }));
  }
  const bounds = {
    VisibilityTimeout: [0, 43200], DelaySeconds: [0, 900], MessageRetentionPeriod: [60, 1209600],
    MaximumMessageSize: [1024, 1048576], ReceiveMessageWaitTimeSeconds: [0, 20],
  };
  for (const [attribute, [minimum, maximum]] of Object.entries(bounds)) {
    for (const value of [minimum, maximum]) {
      assert.ok(await queue(h, { QueueName: `${attribute}-${value}`, Attributes: { [attribute]: String(value) } }));
    }
    for (const value of [String(minimum - 1), String(maximum + 1), '1.5', 'NaN', 'Infinity', '1e2', '']) {
      await rejectsAws(() => queue(h, { QueueName: 'Rejected', Attributes: { [attribute]: value } }));
      await rejectsAws(() => h.call('GetQueueUrl', { QueueName: 'Rejected' }), { code: 'QueueDoesNotExist' });
    }
  }
});

test(evidence(['sqs.CreateQueue', 'sqs.GetQueueUrl'], 'unit', 'FIFO tags policy redrive and encryption are rejected atomically'), async () => {
  const h = sqsHarness();
  const inputs = [
    { QueueName: 'Rejected.fifo', Attributes: { FifoQueue: 'true' } },
    { Attributes: { FifoQueue: 'true' } }, { Attributes: { ContentBasedDeduplication: 'true' } },
    { Attributes: { Policy: '{"Version":"2012-10-17","Statement":[]}' } },
    { Attributes: { RedrivePolicy: '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:000000000000:dlq","maxReceiveCount":"2"}' } },
    { Attributes: { KmsMasterKeyId: 'alias/aws/sqs' } }, { Attributes: { SqsManagedSseEnabled: 'true' } },
    { tags: { team: 'synthetic' } },
  ];
  for (const input of inputs) {
    await rejectsAws(() => queue(h, { QueueName: 'Rejected', ...input }));
    await rejectsAws(() => h.call('GetQueueUrl', { QueueName: input.QueueName ?? 'Rejected' }), { code: 'QueueDoesNotExist' });
  }
});

test(evidence(['sqs.DeleteQueue', 'sqs.GetQueueUrl', 'sqs.ReceiveMessage', 'sqs.DeleteMessage'], 'unit', 'deleting a queue removes messages and receipts without touching its scoped neighbor'), async () => {
  const h = sqsHarness();
  const QueueUrl = await queue(h);
  const other = context({ region: 'eu-west-1' });
  const neighbor = await queue(h, {}, other);
  await h.call('SendMessage', { QueueUrl, MessageBody: 'hello' });
  const [{ ReceiptHandle }] = (await h.call('ReceiveMessage', { QueueUrl })).Messages;
  await h.call('DeleteQueue', { QueueUrl });
  await rejectsAws(() => h.call('GetQueueUrl', { QueueName: 'Synthetic_queue-1' }), { code: 'QueueDoesNotExist' });
  await rejectsAws(() => h.call('ReceiveMessage', { QueueUrl }), { code: 'QueueDoesNotExist' });
  assert.deepEqual(await h.call('GetQueueUrl', { QueueName: 'Synthetic_queue-1' }, other), { QueueUrl: neighbor });
  assert.equal(await queue(h), QueueUrl);
  await rejectsAws(() => h.call('DeleteMessage', { QueueUrl, ReceiptHandle }), { code: 'ReceiptHandleIsInvalid' });
});
