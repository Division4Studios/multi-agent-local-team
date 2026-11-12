import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { TEST_TOKEN, healthValue } from './awsData';
import { observe, rejected } from './awsAsyncFixture';

export const RESPONSE_LIMIT = 2 * 1024 * 1024;
export const EXCERPT_MARKERS: readonly string[] = ['ZXQ', 'QZ7'];

export const assertSafeError = (error: unknown, markers: readonly string[] = EXCERPT_MARKERS): void => {
  assert.ok(error instanceof Error);
  assert.ok(error.message.trim().length > 0);
  assert.notEqual(error.message, 'test fixture deadline exceeded', 'the client must reject rather than outlive a test deadline');
  const displayed = inspect(error, { depth: 8, maxStringLength: null });
  for (const marker of [TEST_TOKEN, ...markers]) { assert.ok(!displayed.includes(marker), `error disclosed marker ${marker}`); }
};

export const assertSafeRejection = async (operation: Promise<unknown>, markers: readonly string[] = EXCERPT_MARKERS): Promise<void> => {
  // A fixture timeout rejects this assertion; it is never accepted as a client rejection.
  assertSafeError(await rejected(observe(operation)), markers);
};

export const paddedHealth = (bytes: number): string => {
  const json = JSON.stringify(healthValue());
  assert.ok(bytes >= Buffer.byteLength(json));
  return json + ' '.repeat(bytes - Buffer.byteLength(json));
};

export interface ResponseScenario {
  readonly reason: string;
  readonly status: number;
  readonly type: string;
  readonly body: string;
  readonly extra: number;
}

export const responseScenarios = (): readonly ResponseScenario[] => [
  { reason: 'HTTP status only', status: 500, type: 'application/json', body: JSON.stringify(healthValue()), extra: 0 },
  { reason: 'media type only', status: 200, type: 'text/html', body: JSON.stringify(healthValue()), extra: 0 },
  { reason: 'malformed JSON excerpt', status: 200, type: 'application/json', body: 'ZXQ-QZ7-private-response', extra: 0 },
  { reason: 'truncation only', status: 200, type: 'application/json', body: JSON.stringify(healthValue()), extra: 50 },
  { reason: 'advertised size only', status: 200, type: 'application/json', body: paddedHealth(RESPONSE_LIMIT + 1), extra: 0 },
  { reason: 'error-body disclosure', status: 500, type: 'application/json', body: `{"ZXQ":"QZ7","token":"${TEST_TOKEN}"}`, extra: 0 },
];
