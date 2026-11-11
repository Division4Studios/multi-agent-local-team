import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateModelFiles } from '../aws-model-data.mts';
import { inspectGenerated, modelFixture, reverseObjectKeys, shapeId } from './aws-model-fixture.mjs';

// Independent regression oracles: foundations.md and Smithy model.html#shape-id-conflicts.
// R1/R2 in task-2-review.md establish earlier public-API reproductions; these
// tests do not assume whether concurrent implementation fixes have landed.
const withTargets = (first, second, reachable = true) => {
  const model = modelFixture();
  model.shapes[first] = { type: 'string', traits: { 'smithy.api#pattern': '^first-regression-target$' } };
  model.shapes[second] = { type: 'string', traits: { 'smithy.api#pattern': '^second-regression-target$' } };
  if (reachable) {
    const members = model.shapes[shapeId('RecordInput')].members;
    members.regressionFirst = { target: first };
    members.regressionSecond = { target: second };
    model.shapes[shapeId('Ledger')].rename = { [first]: 'FirstRegressionTarget', [second]: 'SecondRegressionTarget' };
  }
  return model;
};

for (const [first, second] of [
  ['malt.regression#Twin', 'malt.regression#twin'],
  ['Malt.Regression#Twin', 'malt.regression#Twin'],
  ['Malt.Regression#Twin', 'malt.regression#tWIN'],
]) {
  for (const reachable of [true, false]) {
    test(`rejects case-insensitive absolute ID conflict ${first} / ${second}, reachable=${reachable}`, () => {
      const model = withTargets(first, second, reachable);
      const explanation = (error) => error instanceof Error && /shape|case|conflict|duplicate|identifier/iu.test(error.message);
      assert.throws(() => generateModelFiles(model, 'malt-fixture'), explanation);
      assert.throws(() => generateModelFiles(reverseObjectKeys(model), 'malt-fixture'), explanation);
    });
  }
}

for (const [first, second] of [
  ['malt.regression#Twin', 'malt.regression#TwinExtra'],
  ['malt.first#Twin', 'malt.second#Twin'],
  ['Malt.Regression#First', 'malt.regression#Second'],
]) {
  test(`distinct absolute IDs remain valid: ${first} / ${second}`, () => {
    const parsed = inspectGenerated(generateModelFiles(withTargets(first, second), 'malt-fixture'));
    assert.ok(parsed.facts.has('^first-regression-target$'));
    assert.ok(parsed.facts.has('^second-regression-target$'));
  });
}

for (const wrong of ['malt.regression#Target', 'Malt.Regression#target', 'malt.regression#target']) {
  test(`reference lookup remains case-sensitive: ${wrong}`, () => {
    const model = modelFixture();
    const exact = 'Malt.Regression#Target';
    model.shapes[exact] = { type: 'string', traits: { 'smithy.api#pattern': '^case-sensitive-target$' } };
    model.shapes[shapeId('RecordInput')].members.regressionTarget = { target: exact };
    assert.ok(inspectGenerated(generateModelFiles(model, 'malt-fixture')).facts.has('^case-sensitive-target$'));
    model.shapes[shapeId('RecordInput')].members.regressionTarget.target = wrong;
    assert.throws(() => generateModelFiles(model, 'malt-fixture'), Error);
  });
}

test('operation references also require exact namespace and shape-name casing', () => {
  for (const wrong of ['MALT.SYNTHETIC#Record', 'malt.synthetic#record']) {
    const model = modelFixture();
    inspectGenerated(generateModelFiles(model, 'malt-fixture'));
    model.shapes[shapeId('Ledger')].operations[0].target = wrong;
    assert.throws(() => generateModelFiles(model, 'malt-fixture'), Error);
  }
});

for (const [label, separator] of [['U+2028', '\u2028'], ['U+2029', '\u2029']]) {
  for (const location of ['service', 'member']) {
    test(`${label} in ${location} trait keys preserves inert data within every generated file's line bound`, () => {
      const model = modelFixture();
      const trait = 'malt.regression#keyMap';
      model.shapes[trait] = {
        type: 'map', key: { target: 'smithy.api#String' }, value: { target: 'smithy.api#String' },
        traits: { 'smithy.api#trait': { selector: '*' } },
      };
      const key = `part${separator}`.repeat(417) + '"\\${inert}; // key suffix';
      const value = `preserved-${label}-${location}`;
      const holder = location === 'service' ? model.shapes[shapeId('Ledger')] : model.shapes[shapeId('RecordInput')].members.search;
      holder.traits = { ...holder.traits, [trait]: Object.fromEntries([[key, value], ['__proto__', 'inert-prototype-key']]) };
      const parsed = inspectGenerated(generateModelFiles(model, 'malt-fixture'));
      assert.ok(parsed.facts.has(key), 'the complete decoded key must survive, not be dropped or truncated');
      assert.ok(parsed.facts.has(value));
      assert.ok(parsed.facts.has('__proto__'));
      assert.ok(parsed.facts.has('inert-prototype-key'));
    });
  }
}
