import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { REPOSITORY, ownedTree, run, succeeds } from './aws-foundation-cli-fixture.mjs';

const centralDirectory = (bytes) => {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      return { count: bytes.readUInt16LE(offset + 10), offset: bytes.readUInt32LE(offset + 16) };
    }
  }
  assert.fail('VSIX has no ZIP central directory');
};

const memberBytes = (bytes, offset) => {
  const method = bytes.readUInt16LE(offset + 10);
  const size = bytes.readUInt32LE(offset + 20);
  const originalSize = bytes.readUInt32LE(offset + 24);
  const local = bytes.readUInt32LE(offset + 42);
  assert.equal(bytes.readUInt32LE(local), 0x04034b50);
  const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
  const compressed = bytes.subarray(start, start + size);
  assert.ok(method === 0 || method === 8, `unsupported ZIP method ${method}`);
  const content = method === 0 ? compressed : inflateRawSync(compressed);
  assert.equal(content.length, originalSize);
  return content;
};

const zipEntries = (bytes) => {
  const directory = centralDirectory(bytes);
  const entries = new Map();
  let offset = directory.offset;
  for (let index = 0; index < directory.count; index += 1) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    assert.ok(!entries.has(name), `duplicate ZIP member ${name}`);
    entries.set(name, memberBytes(bytes, offset));
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return entries;
};

export const packageFixture = async () => {
  const tree = await ownedTree();
  const archive = path.join(tree.owner, 'foundation.vsix');
  // VSCE invokes the actual vscode:prepublish hook, which runs the Docker compiler.
  const result = run(process.execPath, [path.join(REPOSITORY, 'node_modules/@vscode/vsce/vsce'), 'package', '--no-dependencies', '--out', archive], REPOSITORY, { timeout: 600_000 });
  try {
    succeeds(result);
    assert.match(result.output, /vscode:prepublish/u, 'packaging must execute the fresh compilation hook');
    return { ...tree, entries: zipEntries(await fs.readFile(archive)), output: result.output };
  } catch (error) {
    await tree.dispose();
    throw error;
  }
};
