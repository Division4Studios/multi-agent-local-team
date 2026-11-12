import assert from 'node:assert/strict';
import { isRecord } from '../../shared/guards';
import type { DockerFixture } from './awsDockerFixture';

export const labelsOf = (value: unknown): Record<string, string> => {
  assert.ok(isRecord(value));
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value)) {
    assert.equal(typeof label, 'string');
    labels[key] = String(label);
  }
  return labels;
};

/** Start from THIS create request; mutate exactly one ownership dimension. */
export const oneLabelMismatch = (current: Readonly<Record<string, string>>, key: string, value = 'different-owner'): Record<string, string> => {
  assert.ok(Object.hasOwn(current, key));
  assert.notEqual(current[key], value);
  const labels = { ...current, [key]: value };
  assert.deepEqual(Object.keys(labels).filter(name => labels[name] !== current[name]), [key]);
  return labels;
};

export const assertOwnedAbsent = (engine: DockerFixture, id: string): void => {
  assert.equal(engine.find(id), undefined, 'the actual owned container must be absent');
};

export const assertForeignPreserved = (engine: DockerFixture): void => {
  assert.ok(engine.foreignContainers.length > 0, 'the collision must create an observable foreign container');
  for (const foreign of engine.foreignContainers) {
    assert.equal(engine.find(foreign.id), foreign, 'foreign container must still exist');
    assert.equal(foreign.running, true, 'foreign container must not be stopped');
  }
};
