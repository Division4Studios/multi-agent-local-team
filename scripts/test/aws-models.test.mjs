import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { generateModelFiles } from '../aws-model-data.mts';
import { HOSTILE_VALUE, modelFixture, reverseObjectKeys, shapeId } from './aws-model-fixture.mjs';

// Independent oracle: specs/aws/foundations.md and Smithy's JSON AST reference.
// Inspect literal data, never execute generated source. The existing TypeScript
// compatibility API is used only to parse; no compiler or new package is needed.
const orderedFiles = (files) => [...files].sort(([left], [right]) => left.localeCompare(right));
const shapePath = (name, ...parts) => ['shapes', shapeId(name), ...parts];
const REMOVE = Symbol('remove');
const edit = (model, keys, value) => {
  const parent = keys.slice(0, -1).reduce((object, key) => object[key], model);
  if (value === REMOVE) {
    delete parent[keys.at(-1)];
  } else {
    parent[keys.at(-1)] = value;
  }
};

const codeLines = (source) => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source.text);
  const lines = new Set();
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const first = source.getLineAndCharacterOfPosition(scanner.getTokenPos()).line;
    const last = source.getLineAndCharacterOfPosition(scanner.getTextPos() - 1).line;
    for (let line = first; line <= last; line += 1) {
      lines.add(line);
    }
  }
  return lines.size;
};

const propertyName = (node) => {
  if (ts.isComputedPropertyName(node)) {
    assert.ok(ts.isStringLiteral(node.expression), 'computed data keys must be literal strings');
    return node.expression.text;
  }
  assert.ok(ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node), 'literal property name');
  assert.notEqual(node.text, '__proto__', 'an uncomputed __proto__ key changes an object prototype instead of preserving a member');
  return node.text;
};

const readObject = (node, facts, bindings) => {
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      assert.equal(property.objectAssignmentInitializer, undefined, 'no executable default expressions');
      facts.add(property.name.text);
      readData(property.name, facts, bindings);
    } else {
      assert.ok(ts.isPropertyAssignment(property), 'data objects cannot contain methods, accessors or dynamic spreads');
      facts.add(propertyName(property.name));
      readData(property.initializer, facts, bindings);
    }
  }
};

const readScalar = (node, facts, bindings) => {
  const constants = new Map([[ts.SyntaxKind.TrueKeyword, true], [ts.SyntaxKind.FalseKeyword, false], [ts.SyntaxKind.NullKeyword, null]]);
  if (constants.has(node.kind)) {
    facts.add(constants.get(node.kind));
  } else if (ts.isPrefixUnaryExpression(node)) {
    assert.equal(node.operator, ts.SyntaxKind.MinusToken, 'only a negative numeric literal is data');
    assert.ok(ts.isNumericLiteral(node.operand));
    facts.add(-Number(node.operand.text));
  } else if (ts.isIdentifier(node)) {
    assert.ok(bindings.has(node.text), `data reference ${node.text} must be a static local/imported binding`);
  } else {
    assert.fail(`generated initializer is executable or non-data: ${ts.SyntaxKind[node.kind]}`);
  }
};

const readData = (node, facts, bindings) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    facts.add(node.text);
  } else if (ts.isNumericLiteral(node)) {
    facts.add(Number(node.text));
  } else if (ts.isObjectLiteralExpression(node)) {
    readObject(node, facts, bindings);
  } else if (ts.isArrayLiteralExpression(node)) {
    node.elements.forEach((element) => readData(element, facts, bindings));
  } else if (ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
    readData(node.expression, facts, bindings);
  } else {
    readScalar(node, facts, bindings);
  }
};

const checkModuleReference = (statement, filename, files) => {
  if (statement.isTypeOnly || statement.importClause?.isTypeOnly || !statement.moduleSpecifier) {
    return;
  }
  assert.ok(ts.isStringLiteral(statement.moduleSpecifier));
  const specifier = statement.moduleSpecifier.text;
  assert.ok(specifier.startsWith('.'), 'runtime imports/re-exports must stay in the generated data file set');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filename.replaceAll('\\', '/')), specifier));
  const candidates = [resolved, resolved.replace(/\.js$/u, '.ts'), `${resolved}.ts`];
  assert.ok([...files.keys()].some((key) => candidates.includes(key.replaceAll('\\', '/'))), `missing generated dependency: ${specifier}`);
};

const inspectStatement = (statement, context) => {
  const { facts, bindings, filename, files } = context;
  if (ts.isVariableStatement(statement)) {
    assert.ok(statement.declarationList.flags & ts.NodeFlags.Const, 'generated data bindings must be const');
    for (const declaration of statement.declarationList.declarations) {
      assert.ok(ts.isIdentifier(declaration.name));
      assert.ok(declaration.initializer, 'data bindings need an initializer');
      readData(declaration.initializer, facts, bindings);
    }
  } else if (ts.isExportAssignment(statement)) {
    readData(statement.expression, facts, bindings);
  } else if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
    checkModuleReference(statement, filename, files);
  } else {
    assert.ok(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement), 'generated modules contain data and types, not handlers or statements');
  }
};

const inspectGenerated = (files) => {
  assert.equal(typeof files?.entries, 'function', 'public result is a filename -> source ReadonlyMap');
  assert.equal(typeof files[Symbol.iterator], 'function');
  assert.ok(files.size > 0, 'generation must produce data');
  const facts = new Set();
  for (const [filename, text] of files) {
    assert.equal(typeof filename, 'string');
    assert.equal(path.posix.parse(filename).root, '', 'no POSIX absolute path');
    assert.equal(path.win32.parse(filename).root, '', 'no Windows absolute/drive-relative path');
    assert.ok(!filename.includes('\0'));
    assert.ok(filename.split(/[\\/]/u).every((part) => part !== '..'), 'paths stay in the service output directory');
    assert.equal(path.extname(filename), '.ts');
    assert.equal(typeof text, 'string');
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    assert.deepEqual(source.parseDiagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')), [], filename);
    assert.ok(codeLines(source) < 400, `${filename} must have fewer than 400 non-comment/nonblank lines`);
    const bindings = new Set();
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        statement.declarationList.declarations.forEach((item) => bindings.add(item.name.getText(source)));
      } else if (ts.isImportDeclaration(statement) && statement.importClause) {
        const visit = (node) => { if (ts.isIdentifier(node)) { bindings.add(node.text); } ts.forEachChild(node, visit); };
        visit(statement.importClause);
      }
    }
    source.statements.forEach((statement) => inspectStatement(statement, { facts, bindings, filename, files }));
  }
  return facts;
};

const requireFact = (facts, value) => {
  const localName = typeof value === 'string' && value.includes('#') ? value.split('#').at(-1) : value;
  assert.ok(facts.has(value) || facts.has(localName), `missing literal model data: ${String(value)}`);
};
const explanatoryError = (error) => error instanceof Error
  && /model|smithy|shape|service|sign|version|operation|member|target|reference|trait|enum|input|output|error|list|map|key|value/iu.test(error.message)
  && !/Cannot (?:read|set|convert)|is not a function|not iterable|Maximum call stack/iu.test(error.message);

test('preserves service metadata and every operation, including error-only and recursive shapes', () => {
  const model = modelFixture();
  const facts = inspectGenerated(generateModelFiles(model, 'malt-fixture'));
  for (const value of ['2041-03-09', 'malt-fixture', 'https://example.invalid/ledger/2041-03-09/', 'aws.protocols#restXml', 'POST', '/records/{recordId}', 202, 'GET', '/inspect', 204]) {
    requireFact(facts, value);
  }
  for (const [id, shape] of Object.entries(model.shapes)) {
    requireFact(facts, id);
    requireFact(facts, shape.type);
  }
  for (const value of ['bad-input', 'too-busy', 'client', 409, 'LedgerRejected']) {
    requireFact(facts, value);
  }
});

test('preserves enums, required/optional members, wire traits, defaults and validation constraints', () => {
  const facts = inspectGenerated(generateModelFiles(modelFixture(), 'malt-fixture'));
  const values = [
    'record_id', 'RecordIdentifier', 'search-filter', 'x-fixture-token', 'x-event-time', 'x-request-id',
    'LabelEntry', 'LabelValue', 'AttributeEntry', 'AttributeKey', 'AttributeValue', 'http-date', 'date-time',
    'accepted-wire', 'delayed-wire', -7, 13, false, 0, 2, 7, 31, 37, '^[a-z][a-z0-9-]*$',
    'smithy.api#required', 'smithy.api#httpLabel', 'smithy.api#httpPayload', 'smithy.api#xmlFlattened',
  ];
  values.forEach((value) => requireFact(facts, value));
});

const SEMANTIC_EDITS = [
  ['service version', shapePath('Ledger', 'version'), '2042-04-10'],
  ['XML namespace', shapePath('Ledger', 'traits', 'smithy.api#xmlNamespace', 'uri'), 'urn:synthetic:changed'],
  ['HTTP method', shapePath('Record', 'traits', 'smithy.api#http', 'method'), 'PUT'],
  ['HTTP status', shapePath('Record', 'traits', 'smithy.api#http', 'code'), 207],
  ['operation errors', shapePath('Record', 'errors'), []],
  ['member target', shapePath('RecordInput', 'members', 'search', 'target'), shapeId('ConstrainedText')],
  ['required member', shapePath('RecordInput', 'members', 'token', 'traits', 'smithy.api#required'), REMOVE],
  ['JSON name', shapePath('RecordInput', 'members', 'recordId', 'traits', 'smithy.api#jsonName'), 'identifier_wire'],
  ['XML name', shapePath('Labels', 'member', 'traits', 'smithy.api#xmlName'), 'ChangedLabel'],
  ['flattened list', shapePath('RecordInput', 'members', 'labels', 'traits', 'smithy.api#xmlFlattened'), REMOVE],
  ['flattened map', shapePath('RecordInput', 'members', 'attributes', 'traits', 'smithy.api#xmlFlattened'), REMOVE],
  ['timestamp format', shapePath('RecordInput', 'members', 'when', 'traits', 'smithy.api#timestampFormat'), 'epoch-seconds'],
  ['HTTP query', shapePath('RecordInput', 'members', 'search', 'traits', 'smithy.api#httpQuery'), 'changed-filter'],
  ['HTTP header', shapePath('RecordInput', 'members', 'token', 'traits', 'smithy.api#httpHeader'), 'x-changed-token'],
  ['HTTP payload', shapePath('RecordOutput', 'members', 'payload', 'traits', 'smithy.api#httpPayload'), REMOVE],
  ['string default', shapePath('Payload', 'members', 'marker', 'traits', 'smithy.api#default'), 'changed-default'],
  ['boolean default', shapePath('Payload', 'members', 'enabled', 'traits', 'smithy.api#default'), true],
  ['range maximum', shapePath('RetryCount', 'traits', 'smithy.api#range', 'max'), 35],
  ['length maximum', shapePath('ConstrainedText', 'traits', 'smithy.api#length', 'max'), 43],
  ['pattern', shapePath('ConstrainedText', 'traits', 'smithy.api#pattern'), '^[a-z]+$'],
  ['enum wire value', shapePath('RejectionCode', 'members', 'BAD_INPUT', 'traits', 'smithy.api#enumValue'), 'rejected-wire'],
  ['integer enum value', shapePath('RetryMode', 'members', 'WAIT', 'traits', 'smithy.api#enumValue'), 17],
  ['legacy enum value', shapePath('LegacyStatus', 'traits', 'smithy.api#enum', 0, 'value'), 'changed-accepted'],
  ['shape kind', shapePath('RetryCount', 'type'), 'long'],
];
for (const [label, keys, value] of SEMANTIC_EDITS) {
  test(`behavioral data cannot be silently discarded: ${label}`, () => {
    const model = modelFixture();
    const before = orderedFiles(generateModelFiles(model, 'malt-fixture'));
    edit(model, keys, value);
    const changed = generateModelFiles(model, 'malt-fixture');
    assert.notDeepEqual(orderedFiles(changed), before, `${label} must affect the generated data`);
    const facts = inspectGenerated(changed);
    if (['string', 'number', 'boolean'].includes(typeof value)) { requireFact(facts, value); }
  });
}

for (const [field, original] of [['input', 'RecordInput'], ['output', 'RecordOutput']]) {
  test(`preserves the operation ${field} edge, not just a bag of shape names`, () => {
    const model = modelFixture();
    model.shapes[shapeId('Alternative')] = JSON.parse(JSON.stringify(model.shapes[shapeId(original)]));
    const before = orderedFiles(generateModelFiles(model, 'malt-fixture'));
    model.shapes[shapeId('Record')][field] = { target: shapeId('Alternative') };
    const changed = generateModelFiles(model, 'malt-fixture');
    assert.notDeepEqual(orderedFiles(changed), before);
    requireFact(inspectGenerated(changed), shapeId('Alternative'));
  });
}

test('selects by signing name and rejects unknown or ambiguous signing services', () => {
  const model = modelFixture();
  model.shapes[shapeId('Other')] = { type: 'service', version: '2099-12-31', operations: [{ target: shapeId('Inspect') }], traits: { 'aws.auth#sigv4': { name: 'other' }, 'aws.protocols#awsJson1_0': {} } };
  const primary = generateModelFiles(model, 'malt-fixture');
  const other = generateModelFiles(model, 'other');
  assert.notDeepEqual(orderedFiles(primary), orderedFiles(other));
  requireFact(inspectGenerated(primary), '2041-03-09');
  requireFact(inspectGenerated(other), '2099-12-31');
  requireFact(inspectGenerated(other), 'other');
  assert.throws(() => generateModelFiles(model, 'missing'), explanatoryError);
  assert.throws(() => generateModelFiles(model, ''), explanatoryError);
  model.shapes[shapeId('Other')].traits['aws.auth#sigv4'].name = 'malt-fixture';
  assert.throws(() => generateModelFiles(model, 'malt-fixture'), explanatoryError);
});

test('preserves AWS Query and AWS JSON protocol declarations', () => {
  for (const protocol of ['aws.protocols#awsQuery', 'aws.protocols#awsJson1_0']) {
    const model = modelFixture();
    delete model.shapes[shapeId('Ledger')].traits['aws.protocols#restXml'];
    model.shapes[shapeId('Ledger')].traits[protocol] = {};
    requireFact(inspectGenerated(generateModelFiles(model, 'malt-fixture')), protocol);
  }
});

test('the signing name is preserved independently of service identity or SDK display name', () => {
  const model = modelFixture();
  const before = orderedFiles(generateModelFiles(model, 'malt-fixture'));
  model.shapes[shapeId('Ledger')].traits['aws.auth#sigv4'].name = 'renamed-signer';
  const changed = generateModelFiles(model, 'renamed-signer');
  assert.notDeepEqual(orderedFiles(changed), before);
  requireFact(inspectGenerated(changed), 'renamed-signer');
});

test('accepts reference-valid optional AST fields and both Smithy 2 version spellings', () => {
  for (const smithy of ['2', '2.0']) {
    const model = modelFixture();
    model.smithy = smithy;
    model.shapes[shapeId('Inspect')] = { type: 'operation' };
    requireFact(inspectGenerated(generateModelFiles(model, 'malt-fixture')), shapeId('Inspect'));
    const service = model.shapes[shapeId('Ledger')];
    delete service.operations;
    model.shapes = { [shapeId('Ledger')]: service };
    requireFact(inspectGenerated(generateModelFiles(model, 'malt-fixture')), '2041-03-09');
  }
});

test('generation is repeatable, independent of nested object key order, and preserves its input', () => {
  const model = modelFixture();
  const snapshot = JSON.stringify(model);
  const first = orderedFiles(generateModelFiles(model, 'malt-fixture'));
  assert.equal(JSON.stringify(model), snapshot);
  assert.deepEqual(orderedFiles(generateModelFiles(model, 'malt-fixture')), first);
  assert.deepEqual(orderedFiles(generateModelFiles(reverseObjectKeys(model), 'malt-fixture')), first);
});

test('hostile strings and prototype-like member names survive as inert literal data', () => {
  const model = modelFixture();
  const members = model.shapes[shapeId('Payload')].members;
  Object.assign(members, Object.fromEntries(['constructor', 'toString'].map((name) => [name, { target: 'smithy.api#String' }])));
  Object.defineProperty(members, '__proto__', { value: { target: 'smithy.api#String', traits: { 'smithy.api#default': 'prototype-member-value' } }, enumerable: true });
  const facts = inspectGenerated(generateModelFiles(model, 'malt-fixture'));
  for (const value of [HOSTILE_VALUE, '__proto__', 'constructor', 'toString', 'prototype-member-value']) { requireFact(facts, value); }
});

test('a large reachable model retains every shape while every generated TS file stays below the line limit', () => {
  const model = modelFixture();
  for (let index = 0; index < 850; index += 1) {
    const name = `Extra${index}`;
    model.shapes[shapeId(name)] = { type: 'string', traits: { 'smithy.api#pattern': `^fixture-${index}$` } };
    model.shapes[shapeId('Payload')].members[name] = { target: shapeId(name) };
  }
  const files = generateModelFiles(model, 'malt-fixture');
  const facts = inspectGenerated(files);
  for (let index = 0; index < 850; index += 1) {
    requireFact(facts, shapeId(`Extra${index}`));
    requireFact(facts, `^fixture-${index}$`);
  }
  assert.deepEqual(orderedFiles(generateModelFiles(reverseObjectKeys(model), 'malt-fixture')), orderedFiles(files));
});

for (const input of [undefined, null, true, 4, 'model', [], {}, { smithy: '2.0' }, { smithy: '2.0', shapes: {} }]) {
  test(`rejects absent/malformed model roots: ${JSON.stringify(input)}`, () => {
    assert.throws(() => generateModelFiles(input, 'malt-fixture'), explanatoryError);
  });
}

const MALFORMED_EDITS = [
  [['smithy'], REMOVE], [['smithy'], 2], [['smithy'], 'invalid'], [['shapes'], null], [['shapes'], []],
  [shapePath('Ledger', 'version'), REMOVE], [shapePath('Ledger', 'version'), 2041],
  [shapePath('Ledger', 'operations'), {}], [shapePath('Ledger', 'operations', 0), 'Record'],
  [shapePath('Ledger', 'operations', 0), {}], [shapePath('Ledger', 'operations', 0, 'target'), shapeId('Missing')],
  [shapePath('Ledger', 'operations', 0, 'target'), shapeId('ConstrainedText')],
  [shapePath('Ledger', 'traits', 'aws.auth#sigv4', 'name'), REMOVE],
  [shapePath('Ledger', 'traits', 'aws.auth#sigv4', 'name'), ''],
  [shapePath('Record'), null], [shapePath('Record', 'type'), REMOVE], [shapePath('Record', 'type'), 'imaginary'],
  [shapePath('Record', 'input'), null], [shapePath('Record', 'input'), 'RecordInput'],
  [shapePath('Record', 'input', 'target'), shapeId('Missing')], [shapePath('Record', 'input', 'target'), shapeId('ConstrainedText')],
  [shapePath('Record', 'output', 'target'), shapeId('Missing')], [shapePath('Record', 'output', 'target'), shapeId('RetryCount')],
  [shapePath('Record', 'errors'), {}], [shapePath('Record', 'errors', 0), {}],
  [shapePath('Record', 'errors', 0, 'target'), shapeId('Missing')], [shapePath('Record', 'errors', 0, 'target'), shapeId('Payload')],
  [shapePath('Inspect', 'output', 'target'), 'smithy.api#NotAPreludeShape'],
  [shapePath('RecordInput', 'members'), []], [shapePath('RecordInput', 'members', 'search'), null],
  [shapePath('RecordInput', 'members', 'search', 'target'), REMOVE], [shapePath('RecordInput', 'members', 'search', 'target'), 7],
  [shapePath('RecordInput', 'members', 'search', 'target'), 'RelativeName'], [shapePath('RecordInput', 'members', 'search', 'target'), shapeId('Missing')],
  [shapePath('RecordInput', 'members', 'search', 'target'), shapeId('Record')],
  [shapePath('RecordInput', 'members', 'search', 'traits'), []],
  [shapePath('Labels', 'member'), REMOVE], [shapePath('Labels', 'member', 'target'), shapeId('Missing')],
  [shapePath('Attributes', 'key'), REMOVE], [shapePath('Attributes', 'value'), REMOVE],
  [shapePath('Attributes', 'key', 'target'), shapeId('RetryCount')], [shapePath('Attributes', 'value', 'target'), shapeId('Missing')],
  [shapePath('Attributes', 'value', 'target'), shapeId('Ledger')],
  [shapePath('RejectionCode', 'members'), {}], [shapePath('RetryMode', 'members', 'WAIT', 'traits', 'smithy.api#enumValue'), 'not-an-integer'],
  [shapePath('ConstrainedText', 'traits'), []],
];
for (const [keys, value] of MALFORMED_EDITS) {
  test(`rejects malformed AST field ${keys.join('/')} = ${String(value)}`, () => {
    const model = modelFixture();
    edit(model, keys, value);
    assert.throws(() => generateModelFiles(model, 'malt-fixture'), explanatoryError);
  });
}

test('rejects malformed shape IDs and member names rather than deriving unsafe output paths', () => {
  for (const name of ['RelativeName', '../outside', 'malt.synthetic#../outside', 'malt.synthetic#Bad Name', 'malt.synthetic#']) {
    const model = modelFixture();
    model.shapes[name] = model.shapes[shapeId('Record')];
    delete model.shapes[shapeId('Record')];
    model.shapes[shapeId('Ledger')].operations[0].target = name;
    assert.throws(() => generateModelFiles(model, 'malt-fixture'), explanatoryError, name);
  }
  for (const name of ['bad-name', '0leading', 'Search']) {
    const model = modelFixture();
    model.shapes[shapeId('RecordInput')].members[name] = { target: 'smithy.api#String' };
    assert.throws(() => generateModelFiles(model, 'malt-fixture'), explanatoryError, name);
  }
});
