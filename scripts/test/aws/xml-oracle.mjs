import assert from 'node:assert/strict';

// Independent test-only XML 1.0 oracle for the ASCII qualified names used by
// AWS Query. It builds a tree; it is not the runtime codec. DTDs are outside the
// Query contract and are rejected, with no entity/file/network resolution.
const xmlNamespace = 'http://www.w3.org/XML/1998/namespace';
const xmlnsNamespace = 'http://www.w3.org/2000/xmlns/';
const qname = '[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?';
const whitespace = /^[\x20\t\n]*$/u;
const entities = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);

function validCharacter(code) {
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff)
    || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

function decode(text) {
  return text.replace(/&(?:#x[\da-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);|&/gu, (reference) => {
    assert.notEqual(reference, '&', 'unescaped ampersand or malformed XML entity');
    const name = reference.slice(1, -1);
    if (name.startsWith('#')) {
      const code = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      assert.ok(validCharacter(code), `invalid XML character reference ${reference}`);
      return String.fromCodePoint(code);
    }
    assert.ok(entities.has(name), `unknown XML entity ${reference}`);
    return entities.get(name);
  });
}

function attributes(source) {
  const values = new Map();
  let remaining = source;
  const attribute = new RegExp(`^[\\x20\\t\\n]+(${qname})[\\x20\\t\\n]*=[\\x20\\t\\n]*(?:"([^"]*)"|'([^']*)')`, 'u');
  while (!whitespace.test(remaining)) {
    const match = attribute.exec(remaining);
    assert.ok(match, `invalid XML attribute syntax: ${remaining}`);
    const value = match[2] ?? match[3];
    assert.ok(!value.includes('<'), 'unescaped less-than in XML attribute');
    assert.ok(!values.has(match[1]), `duplicate XML attribute ${match[1]}`);
    values.set(match[1], decode(value.replace(/[\t\n]/gu, ' ')));
    remaining = remaining.slice(match[0].length);
  }
  return values;
}

function expandedName(name, bindings, isAttribute = false) {
  const parts = name.split(':');
  const prefix = parts.length === 2 ? parts[0] : '';
  const namespace = isAttribute && prefix === '' ? '' : bindings.get(prefix);
  assert.notEqual(namespace, undefined, `undeclared XML namespace prefix ${prefix}`);
  return { name: parts.at(-1), namespace };
}

function element(token, parent) {
  const match = new RegExp(`^<(${qname})([\\s\\S]*?)(/?)>$`, 'u').exec(token);
  assert.ok(match, `invalid XML opening tag ${token}`);
  const values = attributes(match[2]);
  const bindings = new Map(parent?.bindings ?? [['', ''], ['xml', xmlNamespace]]);
  for (const [name, value] of values) {
    if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
    const prefix = name === 'xmlns' ? '' : name.slice(6);
    assert.notEqual(prefix, 'xmlns', 'reserved xmlns prefix');
    assert.notEqual(value, xmlnsNamespace, 'reserved xmlns namespace URI');
    assert.ok(prefix === '' || value !== '', 'empty prefixed namespace');
    assert.equal(prefix === 'xml', value === xmlNamespace, 'reserved xml namespace binding');
    bindings.set(prefix, value);
  }
  const expandedAttributes = new Set();
  for (const [name] of values) {
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    const expanded = expandedName(name, bindings, true);
    const key = `${expanded.namespace}\0${expanded.name}`;
    assert.ok(!expandedAttributes.has(key), `duplicate expanded XML attribute ${name}`);
    expandedAttributes.add(key);
  }
  const expanded = expandedName(match[1], bindings);
  return { ...expanded, qualifiedName: match[1], bindings, children: [], text: '', selfClosing: match[3] === '/' };
}

function instruction(token, offset) {
  const match = new RegExp(`^<\\?(${qname})(?:[\\x20\\t\\n]+[\\s\\S]*?)?\\?>$`, 'u').exec(token);
  assert.ok(match, 'invalid XML processing instruction');
  if (match[1].toLowerCase() !== 'xml') return;
  assert.equal(offset, 0, 'XML declaration must be first');
  assert.match(token, /^<\?xml[\x20\t\n]+version[\x20\t\n]*=[\x20\t\n]*(?:"1\.0"|'1\.0')(?:[\x20\t\n]+encoding[\x20\t\n]*=[\x20\t\n]*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:[\x20\t\n]+standalone[\x20\t\n]*=[\x20\t\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[\x20\t\n]*\?>$/u);
}

export function parseXmlDocument(value) {
  assert.equal(typeof value, 'string');
  for (const character of value) assert.ok(validCharacter(character.codePointAt(0)), 'illegal XML code point');
  const source = value.replace(/^\ufeff/u, '').replace(/\r\n?/gu, '\n');
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(?:(?:"[^"]*")|(?:'[^']*')|[^'">])*?>|[^<]+/gyu;
  const stack = [];
  let root;
  let offset = 0;
  while (offset < source.length) {
    tokens.lastIndex = offset;
    const match = tokens.exec(source);
    assert.ok(match, `invalid or incomplete XML at offset ${offset}`);
    const token = match[0];
    const parent = stack.at(-1);
    if (token.startsWith('<!--')) {
      const comment = token.slice(4, -3);
      assert.ok(!comment.includes('--') && !comment.endsWith('-'), 'invalid XML comment');
    } else if (token.startsWith('<?')) instruction(token, offset);
    else if (token.startsWith('<![CDATA[')) {
      assert.ok(parent, 'CDATA outside the document element');
      parent.text += token.slice(9, -3);
    } else if (token.startsWith('</')) {
      const close = new RegExp(`^</(${qname})[\\x20\\t\\n]*>$`, 'u').exec(token);
      assert.ok(close && parent, 'invalid XML closing tag');
      assert.equal(close[1], parent.qualifiedName, 'mismatched XML closing tag');
      stack.pop();
    } else if (token.startsWith('<')) {
      const node = element(token, parent);
      if (parent) parent.children.push(node);
      else { assert.equal(root, undefined, 'multiple XML document elements'); root = node; }
      if (!node.selfClosing) stack.push(node);
    } else if (parent) {
      assert.ok(!token.includes(']]>'), 'CDATA terminator in ordinary XML text');
      parent.text += decode(token);
    }
    else assert.match(token, whitespace, 'text outside the XML document element');
    offset = tokens.lastIndex;
  }
  assert.ok(root, 'missing XML document element');
  assert.equal(stack.length, 0, 'unclosed XML element');
  return root;
}

export function onlyChildren(node, allowed) {
  assert.match(node.text, whitespace, `unexpected text inside ${node.name}`);
  for (const child of node.children) {
    assert.equal(child.namespace, node.namespace, `wrong namespace on ${child.name}`);
    assert.ok(allowed.includes(child.name), `unexpected ${child.name} under ${node.name}`);
  }
}

export function children(node, name) {
  return node.children.filter((child) => child.name === name && child.namespace === node.namespace);
}

export function oneChild(node, name) {
  const found = children(node, name);
  assert.equal(found.length, 1, `expected exactly one ${node.name}/${name}`);
  return found[0];
}

export function scalar(node) {
  assert.equal(node.children.length, 0, `unexpected child markup inside ${node.name}`);
  return node.text;
}

export function queryValue(root, name) {
  if (root.name === 'ErrorResponse') return scalar(name === 'RequestId'
    ? oneChild(root, name) : oneChild(oneChild(root, 'Error'), name));
  assert.ok(root.name.endsWith('Response'), 'expected a Query response root');
  if (name === 'RequestId') return scalar(oneChild(oneChild(root, 'ResponseMetadata'), name));
  const operation = root.name.slice(0, -'Response'.length);
  const result = oneChild(root, `${operation}Result`);
  const parent = operation === 'ReceiveMessage' ? oneChild(result, 'Message') : result;
  return scalar(oneChild(parent, name));
}

export function queryStructure(root, operation, unit) {
  const resultName = `${operation}Result`;
  onlyChildren(root, [resultName, 'ResponseMetadata']);
  const metadata = oneChild(root, 'ResponseMetadata');
  onlyChildren(metadata, ['RequestId']);
  scalar(oneChild(metadata, 'RequestId'));
  if (unit) {
    assert.ok(children(root, resultName).length <= 1);
    for (const result of children(root, resultName)) onlyChildren(result, []);
    return;
  }
  const result = oneChild(root, resultName);
  if (operation === 'ReceiveMessage') {
    onlyChildren(result, ['Message']);
    for (const message of result.children) {
      const required = ['MessageId', 'ReceiptHandle', 'MD5OfBody', 'Body'];
      onlyChildren(message, [...required, 'Attribute']);
      for (const name of required) scalar(oneChild(message, name));
      for (const attribute of children(message, 'Attribute')) {
        onlyChildren(attribute, ['Name', 'Value']);
        scalar(oneChild(attribute, 'Name'));
        scalar(oneChild(attribute, 'Value'));
      }
    }
  } else {
    const fields = operation === 'GetCallerIdentity' ? ['Account', 'Arn', 'UserId']
      : operation === 'SendMessage' ? ['MessageId', 'MD5OfMessageBody'] : ['QueueUrl'];
    onlyChildren(result, fields);
    for (const name of fields) scalar(oneChild(result, name));
  }
}

export function errorStructure(root) {
  assert.equal(root.name, 'ErrorResponse');
  onlyChildren(root, ['Error', 'RequestId']);
  scalar(oneChild(root, 'RequestId'));
  const error = oneChild(root, 'Error');
  onlyChildren(error, ['Type', 'Code', 'Message']);
  for (const name of ['Type', 'Code', 'Message']) scalar(oneChild(error, name));
}
