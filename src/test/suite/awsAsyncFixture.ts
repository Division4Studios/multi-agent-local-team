import assert from 'node:assert/strict';
import { bounded } from './awsHttpFixture';

type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
export interface Observed<T> {
  readonly settled: boolean;
  readonly result: Promise<Outcome<T>>;
}

/** Attach both handlers immediately, including to pending assertion promises. */
export const observe = <T>(promise: Promise<T>): Observed<T> => {
  let settled = false;
  const result = promise.then(
    (value): Outcome<T> => { settled = true; return { ok: true, value }; },
    (error: unknown): Outcome<T> => { settled = true; return { ok: false, error }; },
  );
  return { get settled(): boolean { return settled; }, result };
};

export const fulfilled = async <T>(operation: Observed<T>): Promise<T> => {
  const result = await bounded(operation.result);
  if (!result.ok) { throw result.error; }
  return result.value;
};

export const rejected = async (operation: Observed<unknown>): Promise<unknown> => {
  const result = await bounded(operation.result);
  assert.equal(result.ok, false, 'the operation itself must reject, not a fixture deadline');
  return result.error;
};

export const drain = async (operations: readonly Observed<unknown>[]): Promise<void> => {
  await bounded(Promise.all(operations.map(async operation => await operation.result)));
};
