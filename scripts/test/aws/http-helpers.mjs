import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL, URLSearchParams } from 'node:url';
import { models, namespaces } from './contract-helpers.mjs';
import { errorStructure, parseXmlDocument, queryStructure, queryValue } from './xml-oracle.mjs';

const require = createRequire(import.meta.url);
export const ADMIN_TOKEN = 'synthetic-local-admin-token-0123456789abcdef';
export const DATE = '20261111T120000Z';

export function deadline(promise, milliseconds, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function rpc(child, command, options, milliseconds = 4000) {
  return new Promise((resolve, reject) => {
    const id = `${command}-${Math.random()}`;
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', receive);
      child.off('exit', exited);
      child.off('error', failed);
    };
    const failed = (error) => { cleanup(); reject(error); };
    const exited = (code, signal) => failed(new Error(`AWS test server exited: ${code ?? signal}`));
    const receive = (message) => {
      if (message.id !== id) return;
      cleanup();
      if (message.error) {
        reject(Object.assign(new Error(message.error.message), message.error));
      } else resolve(message.result);
    };
    const timer = setTimeout(() => failed(new Error(`AWS server ${command} exceeded ${milliseconds}ms`)), milliseconds);
    child.on('message', receive);
    child.once('exit', exited);
    child.once('error', failed);
    child.send({ id, command, options }, (error) => { if (error) failed(error); });
  });
}

async function quiesceRejectedStart(child, failures) {
  try {
    const exited = child.exitCode === null && child.signalCode === null
      ? once(child, 'exit') : Promise.resolve([child.exitCode, child.signalCode]);
    if (child.connected) child.disconnect();
    const [code, signal] = await deadline(exited, 2000, 'rejected AWS process must quiesce');
    assert.equal(code, 0, `rejected AWS process exited with ${signal ?? code}`);
  } catch (error) { failures.push(error); }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await deadline(exited, 2000, 'isolated AWS process termination');
    } catch (error) { failures.push(error); }
  }
}

export async function fixture(t) {
  // Resolve first so pre-implementation red results name the missing public API.
  require.resolve('../../../out/aws/server.js');
  const base = process.platform === 'win32' ? join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  const root = await mkdtemp(join(base, 'malt-aws-runtime-test-'));
  const clients = [];
  const failures = [];
  t.after(async () => {
    for (const client of clients) {
      try {
        if (!client.rejectedStart && client.child.exitCode === null && client.child.signalCode === null) {
          await client.close();
          const exited = once(client.child, 'exit');
          if (client.child.connected) client.child.disconnect();
          const [code, signal] = await deadline(exited, 2000, 'AWS process must quiesce after public close');
          assert.equal(code, 0, `AWS process exited with ${signal ?? code}`);
        }
      } catch (error) { failures.push(error); }
      finally {
        if (client.child.exitCode === null && client.child.signalCode === null) {
          const exited = once(client.child, 'exit');
          client.child.kill('SIGKILL');
          try { await deadline(exited, 2000, 'isolated AWS process termination'); }
          catch (error) { failures.push(error); }
        }
      }
    }
    if (clients.every(({ child }) => child.exitCode !== null || child.signalCode !== null)) {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
    if (failures.length) throw new AggregateError(failures, 'AWS test cleanup failed');
  });
  const start = async (overrides = {}) => {
    const child = fork(new URL('./server-child.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let diagnostics = '';
    child.stderr.on('data', (bytes) => { diagnostics = `${diagnostics}${bytes}`.slice(-4000); });
    const client = { child, close: () => rpc(child, 'close', undefined, 2000) };
    clients.push(client);
    const options = { host: '127.0.0.1', port: 0, adminPort: 0, adminToken: ADMIN_TOKEN, stateDirectory: join(root, 'state'), ...overrides };
    try { Object.assign(client, await rpc(child, 'start', options)); }
    catch (error) {
      client.rejectedStart = true;
      await quiesceRejectedStart(child, failures);
      error.message += diagnostics ? `\n${diagnostics}` : '';
      throw error;
    }
    return client;
  };
  return { root, stateDirectory: join(root, 'state'), start };
}

export function signing(service = 'sqs', region = 'us-east-1', accessKey = 'test') {
  return `AWS4-HMAC-SHA256 Credential=${accessKey}/20261111/${region}/${service}/aws4_request, SignedHeaders=host;x-amz-date, Signature=${'a'.repeat(64)}`;
}

export function presigned(service, region = 'us-east-1') {
  return {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `test/20261111/${region}/${service}/aws4_request`,
    'X-Amz-Date': DATE, 'X-Amz-Expires': '60', 'X-Amz-SignedHeaders': 'host', 'X-Amz-Signature': 'b'.repeat(64),
  };
}

export function request(url, options = {}) {
  const { body = '', method = 'GET', headers = {}, timeout = 3000, path } = options;
  return new Promise((resolve, reject) => {
    const outgoing = Array.isArray(headers) ? [
      ...(headers.some((name, index) => index % 2 === 0 && name.toLowerCase() === 'host') ? [] : ['Host', new URL(url).host]),
      ...headers, 'Content-Length', String(Buffer.byteLength(body)), 'Connection', 'close',
    ] : { ...headers, 'content-length': Buffer.byteLength(body), connection: 'close' };
    const req = httpRequest(url, { method, headers: outgoing, ...(path === undefined ? {} : { path }) }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), bytes: Buffer.concat(chunks).length }));
    });
    const timer = setTimeout(() => req.destroy(new Error(`HTTP ${method} ${path ?? '/'} exceeded ${timeout}ms`)), timeout);
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
    req.end(body);
  });
}

export function jsonCall(server, operation, input = {}, options = {}) {
  return request(server.gatewayUrl, {
    method: 'POST', body: JSON.stringify(input), ...options,
    headers: { authorization: signing('sqs', options.region), 'x-amz-date': DATE,
      'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `AmazonSQS.${operation}`, ...options.headers },
  });
}

export function queryCall(server, service, operation, parameters = {}, options = {}) {
  const form = new URLSearchParams({ Action: operation, Version: models[service].service.version, ...parameters });
  if (options.presigned) for (const [name, value] of Object.entries(presigned(service, options.region))) form.append(name, value);
  const method = options.method ?? 'POST';
  return request(server.gatewayUrl, {
    ...options, method, path: method === 'GET' ? `${options.path ?? '/'}?${form}` : options.path,
    body: method === 'GET' ? '' : form.toString(),
    headers: { ...(options.presigned ? {} : { authorization: signing(service, options.region), 'x-amz-date': DATE }),
      'content-type': 'application/x-www-form-urlencoded', ...options.headers },
  });
}

export function admin(server, path, options = {}) {
  return request(`${server.adminUrl}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json', ...options.headers },
  });
}

export function json(response, status = 200) {
  assert.equal(response.status, status, response.text);
  assert.match(response.headers['content-type'] ?? '', /(?:application\/json|application\/x-amz-json-1\.0)/u);
  return JSON.parse(response.text);
}

export function requestId(response) {
  assert.equal(typeof response.headers['x-amzn-requestid'], 'string');
  assert.ok(response.headers['x-amzn-requestid'].length > 0);
  return response.headers['x-amzn-requestid'];
}

export function xmlText(response, tag) {
  return queryValue(parseXmlDocument(response.text), tag);
}

export function querySuccess(response, service, operation) {
  assert.equal(response.status, 200, response.text);
  assert.match(response.headers['content-type'] ?? '', /xml/u);
  const root = parseXmlDocument(response.text);
  assert.equal(root.name, `${operation}Response`);
  assert.equal(root.namespace, namespaces[service]);
  const modeled = models[service].shapes[`com.amazonaws.${service}#${operation}`];
  assert.ok(modeled, `unknown modeled operation ${service}.${operation}`);
  queryStructure(root, operation, modeled.output.target === 'smithy.api#Unit');
  assert.equal(queryValue(root, 'RequestId'), requestId(response));
}

export function awsFailure(response, protocol, expected = {}) {
  const upperStatus = expected.allowServerFault === true ? 600 : 500;
  assert.ok(response.status >= 400 && response.status < upperStatus, `expected ${upperStatus === 500 ? 'client 4xx' : 'lifecycle 4xx/5xx'} failure: ${response.status} ${response.text}`);
  if (expected.statusCode !== undefined) assert.equal(response.status, expected.statusCode, response.text);
  requestId(response);
  assert.doesNotMatch(response.text, /\bat (?:[\w.]+ \()?[^\n]+:\d+:\d+|node:internal/u);
  let code;
  let message;
  if (protocol === 'json') {
    const value = json(response, response.status);
    assert.equal(typeof value.__type, 'string');
    code = value.__type.split('#').at(-1);
    message = value.message;
    assert.ok(response.headers['x-amzn-errortype'].includes(code));
  } else {
    const root = parseXmlDocument(response.text);
    errorStructure(root);
    assert.equal(queryValue(root, 'Type'), response.status >= 500 && expected.allowServerFault === true ? 'Receiver' : 'Sender');
    assert.equal(queryValue(root, 'RequestId'), requestId(response));
    code = queryValue(root, 'Code');
    message = queryValue(root, 'Message');
  }
  assert.equal(typeof message, 'string');
  assert.ok(message.length > 0);
  if (expected.code) assert.equal(code, expected.code);
  if (expected.message) assert.match(message, expected.message);
  return { code, message };
}
