// Original synthetic, model-valid input examples. Names/flattening were read from
// models/aws/{sts,sqs}.json at revision 3cd98287b471c106254abd89279cc87308d38bfd.
// Wire examples are explicit, not serialized by the codec under test.
export function unsupportedInputs(QueueUrl) {
  const role = 'arn:aws:iam::000000000000:role/synthetic';
  const source = 'arn:aws:sqs:us-east-1:000000000000:synthetic';
  return {
    sts: {
      AssumeRole: { RoleArn: role, RoleSessionName: 'synthetic' },
      AssumeRoleWithSAML: { RoleArn: role, PrincipalArn: 'arn:aws:iam::000000000000:saml-provider/synthetic', SAMLAssertion: 'synthetic-assertion' },
      AssumeRoleWithWebIdentity: { RoleArn: role, RoleSessionName: 'synthetic', WebIdentityToken: 'synthetic-token' },
      AssumeRoot: { TargetPrincipal: '000000000000', 'TaskPolicyArn.arn': 'arn:aws:iam::aws:policy/root-task/IAMDeleteRootUserCredentials' },
      DecodeAuthorizationMessage: { EncodedMessage: 'synthetic-message' },
      GetAccessKeyInfo: { AccessKeyId: 'AKIASYNTHETIC00000000' },
      GetDelegatedAccessToken: { TradeInToken: 'synthetic-trade-in-token' },
      GetFederationToken: { Name: 'synthetic' }, GetSessionToken: {},
      GetWebIdentityToken: { 'Audience.member.1': 'https://synthetic.example.invalid', SigningAlgorithm: 'RS256' },
    },
    sqs: {
      AddPermission: { QueueUrl, Label: 'synthetic', AWSAccountIds: ['000000000000'], Actions: ['SendMessage'] },
      CancelMessageMoveTask: { TaskHandle: 'synthetic-task' },
      ChangeMessageVisibility: { QueueUrl, ReceiptHandle: 'synthetic-receipt', VisibilityTimeout: 0 },
      ChangeMessageVisibilityBatch: { QueueUrl, Entries: [{ Id: 'entry1', ReceiptHandle: 'synthetic-receipt', VisibilityTimeout: 0 }] },
      DeleteMessageBatch: { QueueUrl, Entries: [{ Id: 'entry1', ReceiptHandle: 'synthetic-receipt' }] },
      GetQueueAttributes: { QueueUrl, AttributeNames: ['All'] }, ListDeadLetterSourceQueues: { QueueUrl },
      ListMessageMoveTasks: { SourceArn: source }, ListQueues: {}, ListQueueTags: { QueueUrl }, PurgeQueue: { QueueUrl },
      RemovePermission: { QueueUrl, Label: 'synthetic' },
      SendMessageBatch: { QueueUrl, Entries: [{ Id: 'entry1', MessageBody: 'hello' }] },
      SetQueueAttributes: { QueueUrl, Attributes: { VisibilityTimeout: '0' } },
      StartMessageMoveTask: { SourceArn: source }, TagQueue: { QueueUrl, Tags: { purpose: 'synthetic' } },
      UntagQueue: { QueueUrl, TagKeys: ['purpose'] },
    },
  };
}

export function unsupportedSqsQuery(QueueUrl) {
  return {
    AddPermission: { QueueUrl, Label: 'synthetic', 'AWSAccountId.1': '000000000000', 'ActionName.1': 'SendMessage' },
    CancelMessageMoveTask: { TaskHandle: 'synthetic-task' },
    ChangeMessageVisibility: { QueueUrl, ReceiptHandle: 'synthetic-receipt', VisibilityTimeout: '0' },
    ChangeMessageVisibilityBatch: { QueueUrl, 'ChangeMessageVisibilityBatchRequestEntry.1.Id': 'entry1',
      'ChangeMessageVisibilityBatchRequestEntry.1.ReceiptHandle': 'synthetic-receipt', 'ChangeMessageVisibilityBatchRequestEntry.1.VisibilityTimeout': '0' },
    DeleteMessageBatch: { QueueUrl, 'DeleteMessageBatchRequestEntry.1.Id': 'entry1', 'DeleteMessageBatchRequestEntry.1.ReceiptHandle': 'synthetic-receipt' },
    GetQueueAttributes: { QueueUrl, 'AttributeName.1': 'All' }, ListDeadLetterSourceQueues: { QueueUrl },
    ListMessageMoveTasks: { SourceArn: 'arn:aws:sqs:us-east-1:000000000000:synthetic' }, ListQueues: {}, ListQueueTags: { QueueUrl },
    PurgeQueue: { QueueUrl }, RemovePermission: { QueueUrl, Label: 'synthetic' },
    SendMessageBatch: { QueueUrl, 'SendMessageBatchRequestEntry.1.Id': 'entry1', 'SendMessageBatchRequestEntry.1.MessageBody': 'hello' },
    SetQueueAttributes: { QueueUrl, 'Attribute.1.Name': 'VisibilityTimeout', 'Attribute.1.Value': '0' },
    StartMessageMoveTask: { SourceArn: 'arn:aws:sqs:us-east-1:000000000000:synthetic' },
    TagQueue: { QueueUrl, 'Tag.1.Key': 'purpose', 'Tag.1.Value': 'synthetic' }, UntagQueue: { QueueUrl, 'TagKey.1': 'purpose' },
  };
}
