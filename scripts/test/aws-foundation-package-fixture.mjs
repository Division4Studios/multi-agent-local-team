import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { REPOSITORY, copyRelative, ownedTree, run, snapshot, succeeds } from './aws-foundation-cli-fixture.mjs';

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

const stagePackage = async (workspace) => {
  // Include excluded inputs too: archive boundaries must be enforced by VSCE.
  for (const relative of [
    'package.json', '.vscodeignore', '.npmrc', 'README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY.md',
    'out', 'bin', 'docker', 'docs', 'media', 'models', 'src', 'specs', 'scripts',
  ]) {
    await copyRelative(workspace, relative);
  }
  // CI supplies the current out/ artifact; disable compilation only in this copy.
  const manifestPath = path.join(workspace, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  delete manifest.scripts['vscode:prepublish'];
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
};

const withoutBuildTools = async (tree) => {
  const emptyPath = path.join(tree.owner, 'empty-path');
  await fs.mkdir(emptyPath);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path'));
  Object.assign(env, { PATH: emptyPath, FORCE_COLOR: '0', NO_COLOR: '1' });
  const docker = spawnSync('docker', ['--version'], { cwd: tree.workspace, env, timeout: 10_000 });
  assert.equal(docker.error?.code, 'ENOENT', 'Docker must be unavailable to the packaging subprocess');
  return env;
};

export const packageFixture = async () => {
  const tree = await ownedTree();
  const archive = path.join(tree.owner, 'foundation.vsix');
  await stagePackage(tree.workspace);
  const outputBefore = await snapshot(path.join(tree.workspace, 'out'));
  const env = await withoutBuildTools(tree);
  const result = run(process.execPath, [path.join(REPOSITORY, 'node_modules/@vscode/vsce/vsce'), 'package', '--no-dependencies', '--out', archive], tree.workspace, { env, timeout: 600_000 });
  try {
    succeeds(result);
    assert.deepEqual(await snapshot(path.join(tree.workspace, 'out')), outputBefore, 'packaging must consume the staged compiled artifact unchanged');
    return { ...tree, entries: zipEntries(await fs.readFile(archive)), output: result.output };
  } catch (error) {
    await tree.dispose();
    throw error;
  }
};
