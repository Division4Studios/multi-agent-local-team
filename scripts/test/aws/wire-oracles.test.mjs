import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESCAPED_BODY, ESCAPED_MD5, namespaces } from './contract-helpers.mjs';
import { awsFailure, querySuccess, xmlText } from './http-helpers.mjs';

// Original synthetic controls for the test oracle; not AWS compatibility cases.
const metadata = '<ResponseMetadata><RequestId>request-1</RequestId></ResponseMetadata>';
const identity = '<Account>000000000000</Account><Arn>arn:aws:iam::000000000000:root</Arn><UserId>000000000000</UserId>';
const escapedBody = 'queue &lt;&amp;&gt; "quoted" \'single\' + % / \u{1f600}\n\tcaf\u00e9';
function response(text, status = 200, extra = {}) {
  return { status, text, headers: { 'content-type': 'text/xml', 'x-amzn-requestid': 'request-1', ...extra } };
}
function sts(contents = `<GetCallerIdentityResult>${identity}</GetCallerIdentityResult>${metadata}`) {
  return response(`<GetCallerIdentityResponse xmlns="${namespaces.sts}">${contents}</GetCallerIdentityResponse>`);
}
function received(body = escapedBody) {
  return response(`<ReceiveMessageResponse xmlns="${namespaces.sqs}"><ReceiveMessageResult><Message><MessageId>message-1</MessageId><ReceiptHandle>receipt-1</ReceiptHandle><MD5OfBody>${ESCAPED_MD5}</MD5OfBody><Body>${body}</Body></Message></ReceiveMessageResult>${metadata}</ReceiveMessageResponse>`);
}
function queryError(status, fault) {
  return response(`<ErrorResponse><Error><Type>${fault}</Type><Code>InternalFailure</Code><Message>synthetic failure</Message></Error><RequestId>request-1</RequestId></ErrorResponse>`, status);
}
function jsonError(status) {
  return response('{"__type":"InternalFailure","message":"synthetic failure"}', status,
    { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-errortype': 'InternalFailure' });
}

test('Query oracle accepts modeled result ancestry and correctly escaped message text', () => {
  querySuccess(sts(), 'sts', 'GetCallerIdentity');
  assert.equal(xmlText(sts(), 'Account'), '000000000000');
  querySuccess(received(), 'sqs', 'ReceiveMessage');
  assert.equal(xmlText(received(), 'Body'), ESCAPED_BODY);
});

test('Query oracle rejects the reviewed missing GetCallerIdentityResult false positive', () => {
  const invalid = sts(`${identity}${metadata}`);
  assert.throws(() => querySuccess(invalid, 'sts', 'GetCallerIdentity'));
  assert.throws(() => xmlText(invalid, 'Account'));
});

test('Query oracle rejects the reviewed raw ampersand in an otherwise escaped message', () => {
  const invalid = received(ESCAPED_BODY.replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
  assert.throws(() => querySuccess(invalid, 'sqs', 'ReceiveMessage'));
  assert.throws(() => xmlText(invalid, 'Body'));
});

for (const [label, corrupt] of [
  ['mismatched closing tag', (text) => text.replace('</GetCallerIdentityResult>', '</Wrong>')],
  ['unclosed root', (text) => text.replace('</GetCallerIdentityResponse>', '')],
  ['multiple document roots', (text) => `${text}<Extra/>`],
  ['duplicate XML attribute', (text) => text.replace('<GetCallerIdentityResponse ', '<GetCallerIdentityResponse extra="a" extra="b" ')],
  ['unknown entity', (text) => text.replace('000000000000</Account>', '&unknown;</Account>')],
  ['invalid numeric character reference', (text) => text.replace('000000000000</Account>', '&#0;</Account>')],
  ['metadata nested in result', () => sts(`<GetCallerIdentityResult>${identity}${metadata}</GetCallerIdentityResult>`).text],
  ['duplicate metadata', (text) => text.replace(metadata, metadata + metadata)],
  ['duplicate result wrapper', (text) => text.replace(metadata, `<GetCallerIdentityResult>${identity}</GetCallerIdentityResult>${metadata}`)],
  ['result namespace reset', (text) => text.replace('<GetCallerIdentityResult>', '<GetCallerIdentityResult xmlns="">')],
  ['undeclared namespace prefix', (text) => text.replaceAll('Account>', 'p:Account>')],
  ['RequestId outside metadata', (text) => text.replace(metadata, '<ResponseMetadata/><RequestId>request-1</RequestId>')],
  ['DTD declaration', (text) => `<!DOCTYPE GetCallerIdentityResponse>${text}`],
  ['non-XML declaration whitespace', (text) => `<?xml version\u00a0="1.0"?>${text}`],
]) {
  test(`Query oracle rejects ${label}`, () => {
    assert.throws(() => querySuccess(response(corrupt(sts().text)), 'sts', 'GetCallerIdentity'));
  });
}

test('Query oracle rejects message fields outside a Message and scalar fields with child markup', () => {
  const unwrapped = response(received().text.replace('<Message>', '').replace('</Message>', ''));
  assert.throws(() => querySuccess(unwrapped, 'sqs', 'ReceiveMessage'));
  const nested = response(sts().text.replace('<Account>000000000000</Account>', '<Account><Alias>000000000000</Alias></Account>'));
  assert.throws(() => querySuccess(nested, 'sts', 'GetCallerIdentity'));
});

test('Query oracle decodes numeric and named entities exactly once', () => {
  const value = received('&#38;lt; &amp;gt; &#x1F600;');
  querySuccess(value, 'sqs', 'ReceiveMessage');
  assert.equal(xmlText(value, 'Body'), '&lt; &gt; \u{1f600}');
});

test('Query oracle accepts namespace prefixes declarations comments and processing instructions', () => {
  const prefixed = sts().text.replace(`xmlns="${namespaces.sts}"`, `xmlns:q='${namespaces.sts}'`)
    .replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)/gu, '<$1q:$2');
  const value = response(`\ufeff<?xml version="1.0" encoding="UTF-8"?>\r\n<!--original fixture--><?fixture ok?>${prefixed}`);
  querySuccess(value, 'sts', 'GetCallerIdentity');
  assert.equal(xmlText(value, 'Account'), '000000000000');
});

test('Query oracle preserves CDATA content and character-reference carriage returns', () => {
  const value = received('before<![CDATA[<&> &amp;]]><!--original-->after&#13;');
  querySuccess(value, 'sqs', 'ReceiveMessage');
  assert.equal(xmlText(value, 'Body'), 'before<&> &amp;after\r');
});

test('Query oracle permits a literal CDATA terminator in attributes but rejects it in ordinary text', () => {
  const value = response(sts().text.replace('<Account>', '<Account fixture="]]>" >'));
  querySuccess(value, 'sts', 'GetCallerIdentity');
  assert.equal(xmlText(value, 'Account'), '000000000000');
  assert.throws(() => querySuccess(received('bad ]]> text'), 'sqs', 'ReceiveMessage'));
});

test('Query oracle accepts queue send empty-receive and multi-message result shapes', () => {
  for (const [operation, result] of [
    ['CreateQueue', '<QueueUrl>http://127.0.0.1/queue</QueueUrl>'],
    ['GetQueueUrl', '<QueueUrl>http://127.0.0.1/queue</QueueUrl>'],
    ['SendMessage', `<MessageId>message-1</MessageId><MD5OfMessageBody>${ESCAPED_MD5}</MD5OfMessageBody>`],
    ['ReceiveMessage', ''],
  ]) {
    querySuccess(response(`<${operation}Response xmlns="${namespaces.sqs}"><${operation}Result>${result}</${operation}Result>${metadata}</${operation}Response>`), 'sqs', operation);
  }
  const withAttribute = received().text.replace('</Message>', '<Attribute><Name>ApproximateReceiveCount</Name><Value>1</Value></Attribute></Message>');
  const another = '<Message><MessageId>message-2</MessageId><ReceiptHandle>receipt-2</ReceiptHandle><MD5OfBody>another-digest</MD5OfBody><Body>another body</Body></Message>';
  querySuccess(response(withAttribute.replace('</ReceiveMessageResult>', `${another}</ReceiveMessageResult>`)), 'sqs', 'ReceiveMessage');
});

test('Query oracle permits Unit metadata without inventing a required result wrapper', () => {
  for (const operation of ['DeleteMessage', 'DeleteQueue']) {
    const value = response(`<${operation}Response xmlns="${namespaces.sqs}">${metadata}</${operation}Response>`);
    querySuccess(value, 'sqs', operation);
    assert.equal(xmlText(value, 'RequestId'), 'request-1');
  }
});

test('invalid-input oracle rejects InternalFailure JSON 500', () => {
  assert.throws(() => awsFailure(jsonError(500), 'json'));
});

test('invalid-input oracle rejects Query Receiver 500 and Receiver 400', () => {
  assert.throws(() => awsFailure(queryError(500, 'Receiver'), 'query'));
  assert.throws(() => awsFailure(queryError(400, 'Receiver'), 'query'));
});

test('invalid-input oracle accepts client 4xx Sender and lifecycle allowance is explicit', () => {
  awsFailure(jsonError(400), 'json');
  awsFailure(queryError(400, 'Sender'), 'query');
  awsFailure(jsonError(503), 'json', { allowServerFault: true });
  awsFailure(queryError(503, 'Receiver'), 'query', { allowServerFault: true });
});

test('Query error oracle rejects Code and Message outside the Error element', () => {
  const malformed = response('<ErrorResponse><Error><Type>Sender</Type></Error><Code>InvalidParameterValue</Code><Message>bad input</Message><RequestId>request-1</RequestId></ErrorResponse>', 400);
  assert.throws(() => awsFailure(malformed, 'query'));
});
