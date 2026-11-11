import assert from 'node:assert/strict';
import path from 'node:path';
import ts from 'typescript';

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

// Anchors retain both endpoints even when the two Route operations are rewired.
// A balanced swap changes relationships without changing the AST's literal bag.
export const operationEdgeFixtures = (field) => {
  const original = { smithy: '2.0', shapes: {
    [shapeId('Ledger')]: {
      type: 'service', version: '2041-03-09',
      operations: ['AnchorA', 'AnchorB', 'RouteA', 'RouteB'].map(ref),
      traits: { 'aws.auth#sigv4': { name: 'malt-fixture' }, 'aws.protocols#awsJson1_0': {} },
    },
  } };
  for (const suffix of ['A', 'B']) {
    for (const kind of ['Input', 'Output', 'Error']) {
      original.shapes[shapeId(`${kind}${suffix}`)] = {
        type: 'structure', members: { value: text() },
        ...(kind === 'Error' ? { traits: { 'smithy.api#error': 'client' } } : {}),
      };
    }
    for (const name of ['Anchor', 'Route']) {
      original.shapes[shapeId(`${name}${suffix}`)] = {
        type: 'operation', input: ref(`Input${suffix}`), output: ref(`Output${suffix}`), errors: [ref(`Error${suffix}`)],
      };
    }
  }
  const rewired = JSON.parse(JSON.stringify(original));
  const left = rewired.shapes[shapeId('RouteA')];
  const right = rewired.shapes[shapeId('RouteB')];
  [left[field], right[field]] = [right[field], left[field]];
  const anchored = JSON.parse(JSON.stringify(original));
  delete anchored.shapes[shapeId('RouteA')][field];
  delete anchored.shapes[shapeId('RouteB')][field];
  return { original, rewired, anchored };
};

const targetReferences = (value) => {
  if (Array.isArray(value)) { return value.flatMap(targetReferences); }
  if (value === null || typeof value !== 'object') { return []; }
  return Object.entries(value).flatMap(([key, child]) => key === 'target' && typeof child === 'string' ? [child] : targetReferences(child));
};

export const reachableShapeIds = (model) => {
  const seen = new Set();
  const pending = [shapeId('Ledger')];
  for (const id of pending) {
    if (seen.has(id)) { continue; }
    seen.add(id);
    pending.push(...targetReferences(model.shapes[id]));
  }
  return [...seen].sort();
};

const literals = (value) => {
  if (Array.isArray(value)) { return value.flatMap(literals); }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [JSON.stringify(key), ...literals(child)]);
  }
  return [JSON.stringify(value)];
};
export const literalMultiset = (value) => literals(value).sort();

// Pure test oracle, independently runnable before implementation modules exist.
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
  const entries = [];
  for (const property of node.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      assert.equal(property.objectAssignmentInitializer, undefined, 'no executable default expressions');
      facts.add(property.name.text);
      entries.push([property.name.text, readData(property.name, facts, bindings)]);
    } else {
      assert.ok(ts.isPropertyAssignment(property), 'data objects cannot contain methods, accessors or dynamic spreads');
      const name = propertyName(property.name);
      facts.add(name);
      entries.push([name, readData(property.initializer, facts, bindings)]);
    }
  }
  return ['object', entries.sort(([left], [right]) => left.localeCompare(right))];
};

const readScalar = (node, facts, bindings) => {
  const constants = new Map([[ts.SyntaxKind.TrueKeyword, true], [ts.SyntaxKind.FalseKeyword, false], [ts.SyntaxKind.NullKeyword, null]]);
  if (constants.has(node.kind)) {
    facts.add(constants.get(node.kind));
    return constants.get(node.kind);
  } else if (ts.isPrefixUnaryExpression(node)) {
    assert.equal(node.operator, ts.SyntaxKind.MinusToken, 'only a negative numeric literal is data');
    assert.ok(ts.isNumericLiteral(node.operand));
    facts.add(-Number(node.operand.text));
    return -Number(node.operand.text);
  } else if (ts.isIdentifier(node)) {
    assert.ok(bindings.has(node.text), `data reference ${node.text} must be a static local/imported binding`);
    return ['reference', node.text];
  } else {
    assert.fail(`generated initializer is executable or non-data: ${ts.SyntaxKind[node.kind]}`);
  }
};

const readData = (node, facts, bindings) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    facts.add(node.text);
    return node.text;
  } else if (ts.isNumericLiteral(node)) {
    facts.add(Number(node.text));
    return Number(node.text);
  } else if (ts.isObjectLiteralExpression(node)) {
    return readObject(node, facts, bindings);
  } else if (ts.isArrayLiteralExpression(node)) {
    return ['array', node.elements.map((element) => readData(element, facts, bindings))];
  } else if (ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
    return readData(node.expression, facts, bindings);
  } else {
    return readScalar(node, facts, bindings);
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
  const { facts, data, bindings, filename, files } = context;
  if (ts.isVariableStatement(statement)) {
    assert.ok(statement.declarationList.flags & ts.NodeFlags.Const, 'generated data bindings must be const');
    for (const declaration of statement.declarationList.declarations) {
      assert.ok(ts.isIdentifier(declaration.name));
      assert.ok(declaration.initializer, 'data bindings need an initializer');
      data.push([filename, declaration.name.text, readData(declaration.initializer, facts, bindings)]);
    }
  } else if (ts.isExportAssignment(statement)) {
    data.push([filename, statement.isExportEquals ? 'export=' : 'default', readData(statement.expression, facts, bindings)]);
  } else if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
    checkModuleReference(statement, filename, files);
  } else {
    assert.ok(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEmptyStatement(statement), 'generated modules contain data and types, not handlers or statements');
  }
};

export const inspectGenerated = (files) => {
  assert.equal(typeof files?.entries, 'function', 'public result is a filename -> source ReadonlyMap');
  assert.equal(typeof files[Symbol.iterator], 'function');
  assert.ok(files.size > 0, 'generation must produce data');
  const facts = new Set();
  const data = [];
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
    source.statements.forEach((statement) => inspectStatement(statement, { facts, data, bindings, filename, files }));
  }
  return { facts, data: data.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) };
};

export const assertInitializerAssociations = () => {
  const parse = (source) => inspectGenerated(new Map([['fixture.ts', source]])).data;
  const original = parse('export const table = { left: "A", right: "B" };');
  const annotated = parse('/* changed provenance */ export const table: unknown = { right: \'B\', left: \'A\' };');
  const rewired = parse('export const table = { left: "B", right: "A" };');
  assert.deepEqual(annotated, original);
  assert.deepEqual(literalMultiset(rewired), literalMultiset(original));
  assert.notDeepEqual(rewired, original);
  const factored = parse('const left = "A", right = "B"; export const table = { left, right };');
  const swapped = parse('const left = "B", right = "A"; export const table = { left, right };');
  assert.deepEqual(literalMultiset(swapped), literalMultiset(factored));
  assert.notDeepEqual(swapped, factored, 'referenced constant swaps must retain binding associations');
  assert.deepEqual(parse('/* reordered */ const right = "B", left = "A"; export const table = { right, left };'), factored);
  const modules = (left, right) => inspectGenerated(new Map([
    ['left.ts', `export const value = ${JSON.stringify(left)};`],
    ['right.ts', `export const value = ${JSON.stringify(right)};`],
  ])).data;
  assert.notDeepEqual(modules('A', 'B'), modules('B', 'A'), 'equal binding names in different modules remain distinct');
};
