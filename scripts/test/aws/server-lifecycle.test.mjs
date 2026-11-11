import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { evidence } from './contract-helpers.mjs';
import { admin, deadline, fixture, json, jsonCall, request } from './http-helpers.mjs';

async function listen(t, port = 0) {
  const server = createServer();
  t.after(async () => {
    if (server.listening) await deadline(new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())), 1000, 'port reservation cleanup');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function release(server) {
  await deadline(new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())), 1000, 'port reservation release');
}

async function waitClosed(url) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    try { await request(url, { timeout: 500 }); }
    catch (error) {
      if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET') return;
      throw error;
    }
    await sleep(25);
  }
  assert.fail(`listener still accepts requests after shutdown: ${url}`);
}

test('invalid server options fail before listening and do not strand the state lock', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  for (const options of [
    { adminToken: '' }, { adminToken: 'x'.repeat(31) }, { stateDirectory: 'relative-state' },
    { endpoint: 'https://127.0.0.1:4566' }, { endpoint: 'http://user:pass@127.0.0.1:4566' },
    { endpoint: 'http://127.0.0.1:4566/path' }, { endpoint: 'http://127.0.0.1:4566?query=1' },
    { endpoint: 'http://127.0.0.1:4566#fragment' }, { endpoint: 'not an origin' },
    { port: -1 }, { port: 65536 }, { adminPort: -1 },
  ]) await assert.rejects(() => f.start(options));
  const normal = await f.start();
  assert.equal(json(await admin(normal, '/health')).status, 'running');
});

test('failure of either listener releases the other listener and owned state handles', { timeout: 18000 }, async (t) => {
  const f = await fixture(t);
  const occupied = await listen(t);
  for (const failed of ['gateway', 'admin']) {
    const reservation = await listen(t);
    const freePort = reservation.address().port;
    await release(reservation);
    const options = failed === 'admin' ? { port: freePort, adminPort: occupied.address().port }
      : { port: occupied.address().port, adminPort: freePort };
    await assert.rejects(() => f.start(options), /EADDRINUSE|in use|listen|bind/iu);
    const probe = await listen(t, freePort);
    await release(probe);
    const recovered = await f.start();
    assert.equal(json(await admin(recovered, '/health')).status, 'running');
    await recovered.close();
  }
});

test(evidence(['sqs.GetQueueUrl', 'sqs.ReceiveMessage'], 'lifecycle', 'admin shutdown acknowledges then closes both listeners flushes state and releases ownership'), { timeout: 18000 }, async (t) => {
  const f = await fixture(t);
  const server = await f.start();
  const QueueUrl = json(await jsonCall(server, 'CreateQueue', { QueueName: 'admin-shutdown' })).QueueUrl;
  json(await jsonCall(server, 'SendMessage', { QueueUrl, MessageBody: 'shutdown must flush me' }));
  assert.deepEqual(json(await admin(server, '/shutdown', { method: 'POST', body: '{}' })), { stopping: true });
  await Promise.all([waitClosed(`${server.gatewayUrl}/_health`), waitClosed(`${server.adminUrl}/health`)]);
  // Socket closure and final lock release may be ordered separately. Bound the
  // entire transition, rather than assuming a private shutdown ordering.
  let reopened;
  const end = Date.now() + 2000;
  while (!reopened && Date.now() < end) {
    try { reopened = await f.start(); }
    catch (error) {
      if (!/lock|owner|already|in use/iu.test(error.message)) throw error;
      await sleep(25);
    }
  }
  assert.ok(reopened, 'shutdown must release its state lock within two seconds');
  const local = json(await jsonCall(reopened, 'GetQueueUrl', { QueueName: 'admin-shutdown' })).QueueUrl;
  assert.equal(json(await jsonCall(reopened, 'ReceiveMessage', { QueueUrl: local })).Messages[0].Body, 'shutdown must flush me');
  await server.close();
});
