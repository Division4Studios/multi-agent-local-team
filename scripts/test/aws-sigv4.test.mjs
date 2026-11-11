import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSigningScope } from '../../src/shared/aws/sigv4.ts';

// Oracles: specs/aws/foundations.md; AWS IAM "Create a signed AWS API request"
// (reference_sigv-create-signed-request.html), and S3 sigv4-query-string-auth.html.
// Signatures below are synthetic syntax fixtures, not cryptographic signatures.
const ALGORITHM = 'AWS4-HMAC-SHA256';
const CREDENTIAL = 'test/19000101/moon-1/s3/aws4_request';
const SIGNATURE = '0123456789abcdefABCDEF0123456789'.repeat(2);
const EXPECTED = { accessKeyId: 'test', date: '19000101', region: 'moon-1', service: 's3' };
const FIELDS = { Credential: CREDENTIAL, SignedHeaders: 'host;x-amz-date', Signature: SIGNATURE };
const QUERY = {
  'X-Amz-Algorithm': ALGORITHM, 'X-Amz-Credential': CREDENTIAL,
  'X-Amz-SignedHeaders': 'host;x-amz-date', 'X-Amz-Signature': SIGNATURE,
};
const header = (fields = FIELDS) => `${ALGORITHM} ${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join(', ')}`;
const query = (fields = QUERY) => Object.entries(fields).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
const target = (fields = QUERY) => `/bucket/key?${query(fields)}`;
const without = (fields, key) => Object.fromEntries(Object.entries(fields).filter(([name]) => name !== key));

test('documented IAM header form yields exactly the credential scope', () => {
  const authorization = `AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20220830/us-east-1/ec2/aws4_request, SignedHeaders=host;x-amz-date, Signature=${SIGNATURE}`;
  assert.deepEqual(parseSigningScope(authorization, '/?Action=DescribeInstances&Version=2016-11-15'), {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', date: '20220830', region: 'us-east-1', service: 'ec2',
  });
});

test('header attribute order and surrounding spaces/tabs do not change the scope', () => {
  const orders = [
    ['Credential', 'SignedHeaders', 'Signature'], ['Credential', 'Signature', 'SignedHeaders'],
    ['SignedHeaders', 'Credential', 'Signature'], ['SignedHeaders', 'Signature', 'Credential'],
    ['Signature', 'Credential', 'SignedHeaders'], ['Signature', 'SignedHeaders', 'Credential'],
  ];
  for (const order of orders) {
    const fields = order.map((key) => `${key}=${FIELDS[key]}`);
    assert.deepEqual(parseSigningScope(`${ALGORITHM} ${fields.join(',')}`, '/'), EXPECTED);
    const padded = order.map((key) => `\t${key} \t=\t ${FIELDS[key]} \t`).join(' ,\t');
    assert.deepEqual(parseSigningScope(` \t${ALGORITHM}\t ${padded}\t `, '/'), EXPECTED);
  }
});

test('scope syntax accepts local keys, arbitrary regions/services, and dates without age checks', () => {
  const examples = [
    ['test', '19000101', 'moon-base-2049', 's3-outposts'],
    ['aB09', '99999999', 'local', 'execute-api'],
    ['0', '00000000', 'r9', 'service9'],
  ];
  for (const [accessKeyId, date, region, service] of examples) {
    const credential = `${accessKeyId}/${date}/${region}/${service}/aws4_request`;
    const expected = { accessKeyId, date, region, service };
    assert.deepEqual(parseSigningScope(header({ ...FIELDS, Credential: credential }), '/'), expected);
    assert.deepEqual(parseSigningScope(undefined, target({ ...QUERY, 'X-Amz-Credential': credential })), expected);
  }
});

test('SignedHeaders accepts lowercase HTTP token names and either hex signature case', () => {
  for (const signedHeaders of ['host', 'content-type;host;x-amz-date', "host;x!#$%&'*+-.^_`|~012"]) {
    for (const signature of [SIGNATURE.toLowerCase(), SIGNATURE.toUpperCase(), '0'.repeat(64)]) {
      assert.deepEqual(parseSigningScope(header({ ...FIELDS, SignedHeaders: signedHeaders, Signature: signature }), '/'), EXPECTED);
      assert.deepEqual(parseSigningScope(undefined, target({ ...QUERY, 'X-Amz-SignedHeaders': signedHeaders, 'X-Amz-Signature': signature })), EXPECTED);
    }
  }
});

test('presign syntax allows Date, Expires and token parameters without requiring them', () => {
  const raw = `/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=${SIGNATURE}`;
  assert.deepEqual(parseSigningScope(undefined, raw), {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE', date: '20130524', region: 'us-east-1', service: 's3',
  });
  assert.deepEqual(parseSigningScope(undefined, target()), EXPECTED);
  assert.deepEqual(parseSigningScope(undefined, `${target()}&X-Amz-Security-Token=a%2Bb%2Fc%3D`), EXPECTED);
});

test('ordinary unsigned query parameters are allowed alongside either authentication form', () => {
  const ordinary = 'Action=ListQueues&Version=2012-11-05&tag=one&tag=two&acl&empty=&prefix=a+b%2Fc&token=a=b==&label=%E9%9B%AA&X-Amz-Trace-Id=trace';
  assert.deepEqual(parseSigningScope(header(), `/bucket?${ordinary}`), EXPECTED);
  assert.deepEqual(parseSigningScope(undefined, `/bucket?${ordinary}&${query()}`), EXPECTED);
  assert.deepEqual(parseSigningScope(undefined, `${target()}&${ordinary}`), EXPECTED);
  for (const raw of ['/', '/?', '/?acl', `/?${ordinary}`, '/?Credential=test', '/?X-Amz-Credentialish=test']) {
    assert.equal(parseSigningScope(undefined, raw), undefined, raw);
  }
});

test('query authentication decodes names and values once, independent of field order', () => {
  const reversed = query(Object.fromEntries(Object.entries(QUERY).reverse()));
  const encodedNames = reversed.replace('X-Amz-Credential', '%58-Amz-%43redential').replace('X-Amz-SignedHeaders', 'X-Amz-%53ignedHeaders');
  assert.deepEqual(parseSigningScope(undefined, `/?${encodedNames.replaceAll('%2F', '%2f')}`), EXPECTED);
  assert.deepEqual(parseSigningScope(undefined, `${target()}&ordinary=%252G&%2558-Amz-Credential=ordinary`), EXPECTED);
  assert.equal(parseSigningScope(undefined, target().replaceAll('%2F', '%252F')), undefined, 'a second decode would incorrectly accept the credential');
  assert.equal(parseSigningScope(undefined, target().replace('X-Amz-Algorithm', '%2558-Amz-Algorithm')), undefined);
});

test('raw S3 paths stay opaque while only the original query substring supplies credentials', () => {
  const paths = ['/bucket/a//b/./c/../key', '/bucket/%2e%2E/%2f/%2F/%252F/a+b', '/bucket/%ZZ/%/雪', '/bucket/%3Fnot-a-query%26x'];
  for (const path of paths) {
    const request = Object.freeze({ rawTarget: `${path}?${query()}&prefix=one+two%2Fthree` });
    const original = request.rawTarget;
    assert.deepEqual(parseSigningScope(undefined, request.rawTarget), EXPECTED, path);
    assert.equal(request.rawTarget, original);
    assert.deepEqual(parseSigningScope(header(), `${path}?prefix=one+two%2Fthree`), EXPECTED);
  }
  assert.equal(parseSigningScope(undefined, `/bucket/${query()}`), undefined, 'auth-looking path text is not a query');
  assert.equal(parseSigningScope(undefined, `/bucket/${encodeURIComponent(`?${query()}`)}`), undefined);
  assert.equal(parseSigningScope(undefined, `/?ordinary=?${query()}`), undefined, 'do not restart parsing at the second question mark');
  assert.deepEqual(parseSigningScope(header(), `/bucket/${query()}`), EXPECTED, 'path text is not mixed authentication');
});

test('raw query authentication cannot be repaired by URL fragment handling or control-character normalization', () => {
  assert.equal(parseSigningScope(undefined, `${target()}#fragment`), undefined, 'the raw signature value includes the hash suffix');
  assert.equal(parseSigningScope(undefined, target().replace('test%2F', 'te\tst%2F')), undefined);
  assert.equal(parseSigningScope(undefined, `${target()}\n`), undefined, 'a raw trailing newline is not stripped from the signature');
});

const INVALID_CREDENTIALS = [
  '', '/19000101/moon-1/s3/aws4_request', 'te_st/19000101/moon-1/s3/aws4_request',
  'te-st/19000101/moon-1/s3/aws4_request', 'téšt/19000101/moon-1/s3/aws4_request',
  'te+st/19000101/moon-1/s3/aws4_request', 'te st/19000101/moon-1/s3/aws4_request',
  'test//moon-1/s3/aws4_request', 'test/1900010/moon-1/s3/aws4_request',
  'test/190001011/moon-1/s3/aws4_request', 'test/1900-101/moon-1/s3/aws4_request',
  'test/1900a101/moon-1/s3/aws4_request', 'test/１９０００１０１/moon-1/s3/aws4_request',
  'test/19000101//s3/aws4_request', 'test/19000101/Moon-1/s3/aws4_request',
  'test/19000101/moon_1/s3/aws4_request', 'test/19000101/moon.1/s3/aws4_request',
  'test/19000101/moon 1/s3/aws4_request', 'test/19000101/moon-1//aws4_request',
  'test/19000101/moon-1/S3/aws4_request', 'test/19000101/moon-1/s_3/aws4_request',
  'test/19000101/moon-1/s+3/aws4_request', 'test/19000101/moon-1/s3/aws4_Request',
  'test/19000101/moon-1/s3/aws4_request/extra', 'test/19000101/moon-1/s3/aws4_request/',
  'test/19000101/moon-1/s3', 'test/19000101/moon-1/s3/',
  '/test/19000101/moon-1/s3/aws4_request', 'test\t/19000101/moon-1/s3/aws4_request',
  'test/19000101/moon-1/s3/aws4_request\n', encodeURIComponent(CREDENTIAL),
];
for (const credential of INVALID_CREDENTIALS) {
  test(`rejects malformed scope in both authentication forms: ${JSON.stringify(credential)}`, () => {
    assert.equal(parseSigningScope(header({ ...FIELDS, Credential: credential }), '/'), undefined);
    assert.equal(parseSigningScope(undefined, target({ ...QUERY, 'X-Amz-Credential': credential })), undefined);
  });
}

const BAD_SIGNED_HEADERS = ['', 'Host', 'host;;x-amz-date', 'host;', ';host', 'host x-amz-date', 'host; x-amz-date', 'host;x/amz', 'host;:authority', 'host;é', 'host;x=amz', 'host;\tx-amz-date'];
const BAD_SIGNATURES = ['', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), `0x${'a'.repeat(62)}`, `${'a'.repeat(63)}é`, `${'a'.repeat(32)} ${'a'.repeat(31)}`];
for (const [field, invalidValues] of [['SignedHeaders', BAD_SIGNED_HEADERS], ['Signature', BAD_SIGNATURES]]) {
  for (const value of invalidValues) {
    test(`rejects malformed ${field} in header and query: ${JSON.stringify(value)}`, () => {
      assert.equal(parseSigningScope(header({ ...FIELDS, [field]: value }), '/'), undefined);
      assert.equal(parseSigningScope(undefined, target({ ...QUERY, [`X-Amz-${field}`]: value })), undefined);
    });
  }
}

for (const field of Object.keys(FIELDS)) {
  test(`requires exactly one nonempty header ${field}`, () => {
    assert.equal(parseSigningScope(header(without(FIELDS, field)), '/'), undefined);
    assert.equal(parseSigningScope(header({ ...FIELDS, [field]: '' }), '/'), undefined);
    for (const duplicate of [FIELDS[field], 'conflicting']) {
      assert.equal(parseSigningScope(`${header()}, ${field}=${duplicate}`, '/'), undefined);
      assert.equal(parseSigningScope(`${ALGORITHM} ${field}=${duplicate}, ${header().slice(ALGORITHM.length + 1)}`, '/'), undefined);
    }
  });
}

const BAD_HEADERS = [
  '', ' ', 'Basic dGVzdDp0ZXN0', CREDENTIAL, ALGORITHM,
  header().replace(ALGORITHM, 'AWS4-ECDSA-P256-SHA256'), header().replace(ALGORITHM, 'aws4-hmac-sha256'),
  header().replace(ALGORITHM, 'AWS4-HMAC-SHA256suffix'),
  header().replace(`${ALGORITHM} `, `${ALGORITHM}, `), header().replace(`${ALGORITHM} `, ALGORITHM),
  header().replaceAll(', ', ' '), header().replace(', ', ',, '), `${header()},`,
  `${header()}, Unknown=value`, header().replace('Credential=', 'credential='),
  header().replace('SignedHeaders=', 'signedheaders='), header().replace('Signature=', 'signature='),
  header().replace('Credential=', 'Credential:'), header().replace('Signature=', 'Signature=='),
  header({ ...FIELDS, Credential: `"${CREDENTIAL}"` }), header({ ...FIELDS, Signature: `"${SIGNATURE}"` }),
  `${header()}\r\n`, `\n${header()}`, header().replace(', ', ',\r\n '),
  header().replace(`${ALGORITHM} `, `${ALGORITHM}\u00a0`), header().replace(', ', ',\v'),
  `Bearer ${header()}`, `${header()}, ${header()}`,
];
for (const authorization of BAD_HEADERS) {
  test(`malformed present Authorization never falls back: ${JSON.stringify(authorization)}`, () => {
    assert.equal(parseSigningScope(authorization, '/'), undefined);
    assert.equal(parseSigningScope(authorization, target()), undefined);
  });
}

for (const field of Object.keys(QUERY)) {
  test(`requires exactly one nonempty query ${field}, including percent-encoded duplicate names`, () => {
    assert.equal(parseSigningScope(undefined, target(without(QUERY, field))), undefined);
    assert.equal(parseSigningScope(undefined, target({ ...QUERY, [field]: '' })), undefined);
    assert.equal(parseSigningScope(undefined, `${target(without(QUERY, field))}&${field}`), undefined);
    assert.equal(parseSigningScope(undefined, target().replace(field, field.toLowerCase())), undefined);
    for (const duplicate of [QUERY[field], 'conflicting']) {
      const encoded = encodeURIComponent(duplicate);
      assert.equal(parseSigningScope(undefined, `${target()}&${field}=${encoded}`), undefined);
      assert.equal(parseSigningScope(undefined, `/?%58${field.slice(1)}=${encoded}&${query()}`), undefined);
    }
  });
}

test('query algorithms use the exact supported algorithm token', () => {
  for (const algorithm of ['AWS4-ECDSA-P256-SHA256', 'AWS-HMAC-SHA256', 'aws4-hmac-sha256', ` ${ALGORITHM}`, `${ALGORITHM}\n`]) {
    assert.equal(parseSigningScope(undefined, target({ ...QUERY, 'X-Amz-Algorithm': algorithm })), undefined);
  }
});

for (const malformed of ['%', '%2', '%GG', '%C3%28', '%FF', '%C0%AF', '%ED%A0%80']) {
  test(`strict percent decoding rejects malformed names and values: ${malformed}`, () => {
    assert.equal(parseSigningScope(undefined, `${target()}&ordinary=${malformed}`), undefined);
    assert.equal(parseSigningScope(undefined, `${target()}&${malformed}=ordinary`), undefined);
    assert.equal(parseSigningScope(undefined, target().replace('test%2F', `${malformed}%2F`)), undefined);
    assert.equal(parseSigningScope(undefined, target().replace('X-Amz-Algorithm', `${malformed}X-Amz-Algorithm`)), undefined);
  });
}

test('header and query authentication cannot be mixed, even with identical scopes or partial query auth', () => {
  assert.equal(parseSigningScope(header(), target()), undefined);
  assert.equal(parseSigningScope(header(), target({ ...QUERY, 'X-Amz-Credential': 'other/20261111/local/sts/aws4_request' })), undefined);
  for (const [field, value] of Object.entries(QUERY)) {
    assert.equal(parseSigningScope(header(), `/?${field}=${encodeURIComponent(value)}`), undefined, field);
    assert.equal(parseSigningScope(header(), `/?%58${field.slice(1)}=${encodeURIComponent(value)}`), undefined, field);
  }
});
