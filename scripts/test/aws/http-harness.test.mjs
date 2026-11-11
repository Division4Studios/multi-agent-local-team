import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { URLSearchParams } from 'node:url';
import { deadline, json, queryCall, request, signing } from './http-helpers.mjs';

// Transport-fixture checks only; these do not contribute AWS evidence and do not
// implement any AWS service. They ensure negative wire tests send what they claim.
async function localProbe(t, handler) {
  const server = createServer(handler);
  t.after(async () => {
    server.closeAllConnections();
    await deadline(new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())), 1000, 'transport probe cleanup');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('runtime test transport really sends repeated Authorization headers and an unnormalized request target', { timeout: 3000 }, async (t) => {
  const url = await localProbe(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ target: req.url, headers: req.rawHeaders }));
  });
  const response = json(await request(url, { path: '/queue//raw/../%2F+?x=1&x=2',
    headers: ['Authorization', signing(), 'Authorization', signing('sts')] }));
  assert.equal(response.target, '/queue//raw/../%2F+?x=1&x=2');
  const auth = [];
  for (let index = 0; index < response.headers.length; index += 2) {
    if (response.headers[index].toLowerCase() === 'authorization') auth.push(response.headers[index + 1]);
  }
  assert.deepEqual(auth, [signing(), signing('sts')]);
});

test('runtime test Query fixture preserves plus percent Unicode and distinguishes signed form from presigned GET', { timeout: 3000 }, async (t) => {
  const gatewayUrl = await localProbe(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString('utf8');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body }));
  });
  const sent = json(await queryCall({ gatewayUrl }, 'sqs', 'SendMessage', { MessageBody: '+ % \u{1f600}' }));
  assert.equal(new URLSearchParams(sent.body).get('MessageBody'), '+ % \u{1f600}');
  assert.equal(sent.headers.authorization, signing('sqs'));
  assert.equal(sent.method, 'POST');
  const get = json(await queryCall({ gatewayUrl }, 'sts', 'GetCallerIdentity', {}, { method: 'GET', presigned: true }));
  assert.equal(get.headers.authorization, undefined);
  assert.equal(get.body, '');
  assert.equal(new URLSearchParams(get.url.split('?')[1]).get('X-Amz-Credential'), 'test/20261111/us-east-1/sts/aws4_request');
});

test('runtime test HTTP deadline actively aborts an unresponsive socket', { timeout: 3000 }, async (t) => {
  const url = await localProbe(t, (req) => { req.resume(); });
  await assert.rejects(() => request(url, { timeout: 80 }), /exceeded 80ms/u);
});
