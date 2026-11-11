// Original synthetic Smithy 2.0 AST, not copied from an AWS service model.
// Syntax: https://smithy.io/2.0/spec/json-ast.html
// Signing trait: https://smithy.io/2.0/aws/aws-auth.html#aws-auth-sigv4-trait
export const shapeId = (name) => `malt.synthetic#${name}`;
const ref = (name) => ({ target: shapeId(name) });
const text = (traits = {}) => ({ target: 'smithy.api#String', traits });

export const HOSTILE_VALUE = 'quote" apostrophe\' slash\\ newline\n\r\t\u0000 雪 😀 \u2028\u2029 ${process.exit(9)} `; throw new Error("injected"); // </script>';

const MODEL = {
  smithy: '2.0',
  shapes: {
    [shapeId('Ledger')]: {
      type: 'service', version: '2041-03-09',
      operations: [ref('Record'), ref('Inspect')],
      traits: {
        'aws.api#service': { sdkId: 'Synthetic Ledger' },
        'aws.auth#sigv4': { name: 'malt-fixture' },
        'aws.protocols#restXml': {},
        'smithy.api#xmlNamespace': { uri: 'https://example.invalid/ledger/2041-03-09/' },
        'smithy.api#documentation': 'Original service documentation; removal is optional.',
      },
    },
    [shapeId('Record')]: {
      type: 'operation', input: ref('RecordInput'), output: ref('RecordOutput'),
      errors: [ref('Rejected')],
      traits: { 'smithy.api#http': { method: 'POST', uri: '/records/{recordId}', code: 202 } },
    },
    [shapeId('Inspect')]: {
      type: 'operation',
      input: { target: 'smithy.api#Unit' }, output: { target: 'smithy.api#Unit' },
      traits: { 'smithy.api#http': { method: 'GET', uri: '/inspect', code: 204 } },
    },
    [shapeId('RecordInput')]: {
      type: 'structure',
      members: {
        recordId: { ...ref('ConstrainedText'), traits: {
          'smithy.api#required': {}, 'smithy.api#httpLabel': {},
          'smithy.api#jsonName': 'record_id', 'smithy.api#xmlName': 'RecordIdentifier',
        } },
        search: text({ 'smithy.api#httpQuery': 'search-filter' }),
        token: text({ 'smithy.api#required': {}, 'smithy.api#httpHeader': 'x-fixture-token' }),
        labels: { ...ref('Labels'), traits: { 'smithy.api#xmlFlattened': {}, 'smithy.api#xmlName': 'LabelEntry' } },
        attributes: { ...ref('Attributes'), traits: { 'smithy.api#xmlFlattened': {}, 'smithy.api#xmlName': 'AttributeEntry' } },
        when: { ...ref('Clock'), traits: { 'smithy.api#timestampFormat': 'http-date', 'smithy.api#httpHeader': 'x-event-time' } },
        retries: { ...ref('RetryCount'), traits: { 'smithy.api#default': 2 } },
        legacyStatus: ref('LegacyStatus'),
        mode: ref('RetryMode'),
      },
    },
    [shapeId('RecordOutput')]: {
      type: 'structure',
      members: {
        payload: { ...ref('Payload'), traits: { 'smithy.api#httpPayload': {} } },
        requestId: text({ 'smithy.api#httpHeader': 'x-request-id' }),
      },
    },
    [shapeId('Payload')]: {
      type: 'structure',
      members: {
        marker: text({ 'smithy.api#default': HOSTILE_VALUE }),
        enabled: { target: 'smithy.api#Boolean', traits: { 'smithy.api#default': false } },
        link: ref('Link'),
        empty: ref('Empty'),
        binary: { target: 'smithy.api#Blob' },
      },
    },
    [shapeId('Link')]: { type: 'structure', members: { next: ref('Link'), value: text() } },
    [shapeId('Empty')]: { type: 'structure' },
    [shapeId('ConstrainedText')]: {
      type: 'string',
      traits: { 'smithy.api#pattern': '^[a-z][a-z0-9-]*$', 'smithy.api#length': { min: 2, max: 37 } },
    },
    [shapeId('RetryCount')]: { type: 'integer', traits: { 'smithy.api#range': { min: 0, max: 31 } } },
    [shapeId('Clock')]: { type: 'timestamp', traits: { 'smithy.api#timestampFormat': 'date-time' } },
    [shapeId('Labels')]: {
      type: 'list', member: text({ 'smithy.api#xmlName': 'LabelValue' }),
      traits: { 'smithy.api#length': { min: 1, max: 7 } },
    },
    [shapeId('Attributes')]: {
      type: 'map',
      key: text({ 'smithy.api#xmlName': 'AttributeKey' }),
      value: text({ 'smithy.api#xmlName': 'AttributeValue' }),
    },
    [shapeId('LegacyStatus')]: {
      type: 'string', traits: { 'smithy.api#enum': [
        { name: 'ACCEPTED', value: 'accepted-wire' }, { name: 'DELAYED', value: 'delayed-wire' },
      ] },
    },
    [shapeId('RetryMode')]: {
      type: 'intEnum', members: {
        IMMEDIATE: { target: 'smithy.api#Unit', traits: { 'smithy.api#enumValue': -7 } },
        WAIT: { target: 'smithy.api#Unit', traits: { 'smithy.api#enumValue': 13 } },
      },
    },
    [shapeId('Rejected')]: {
      type: 'structure',
      traits: { 'smithy.api#error': 'client', 'smithy.api#httpError': 409, 'smithy.api#xmlName': 'LedgerRejected' },
      members: { reason: ref('RejectionCode'), context: ref('RejectionContext') },
    },
    [shapeId('RejectionCode')]: {
      type: 'enum', members: {
        BAD_INPUT: { target: 'smithy.api#Unit', traits: { 'smithy.api#enumValue': 'bad-input' } },
        TOO_BUSY: { target: 'smithy.api#Unit', traits: { 'smithy.api#enumValue': 'too-busy' } },
      },
    },
    [shapeId('RejectionContext')]: {
      type: 'union', members: { note: text(), attempts: ref('RetryCount') },
    },
  },
};

export const modelFixture = () => JSON.parse(JSON.stringify(MODEL));

export const reverseObjectKeys = (value) => {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseObjectKeys(child)]));
  }
  return value;
};
