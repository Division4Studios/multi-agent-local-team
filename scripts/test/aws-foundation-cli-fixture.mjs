import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

export const REPOSITORY = fileURLToPath(new URL('../../', import.meta.url));
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const run = (command, args, cwd, options = {}) => {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, ...options,
  });
  assert.equal(result.error, undefined, `command could not run: ${result.error?.message}`);
  assert.equal(result.signal, null, `command terminated by ${result.signal}`);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
};
export const succeeds = (result) => assert.equal(result.status, 0, result.output);
export const fails = (result) => assert.notEqual(result.status, 0, `unexpected success:\n${result.output}`);

export const ownedTree = async () => {
  const base = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const owner = await fs.mkdtemp(path.join(base, 'malt-aws-foundation-'));
  const workspace = path.join(owner, 'workspace');
  await fs.mkdir(workspace);
  return { owner, workspace, dispose: () => fs.rm(owner, { recursive: true, force: true, maxRetries: 3 }) };
};

export const copyRelative = async (workspace, relative) => {
  const target = path.join(workspace, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(path.join(REPOSITORY, relative), target, { recursive: true, dereference: true });
};

export const cliFixture = async (context) => {
  const tree = await ownedTree();
  context.after(tree.dispose);
  for (const relative of ['package.json', '.npmrc', 'models/aws']) {
    await copyRelative(tree.workspace, relative);
  }
  for (const name of await fs.readdir(path.join(REPOSITORY, 'scripts'))) {
    if (/^aws-model.*\.mts$/u.test(name)) { await copyRelative(tree.workspace, `scripts/${name}`); }
  }
  await fs.mkdir(path.join(tree.workspace, 'src/aws/models'), { recursive: true });
  return tree;
};

export const cli = (tree, args = [], readOnly = false) => run(process.execPath, [
  '--permission', '--allow-fs-read=*',
  ...(readOnly ? [] : [`--allow-fs-write=${tree.owner}`]),
  path.join(tree.workspace, 'scripts/aws-models.mts'), ...args,
], tree.workspace);

export const npmScript = (tree, name) => {
  assert.ok(['generate:aws-models', 'check:aws-models'].includes(name));
  const windows = process.platform === 'win32';
  const command = windows ? process.env.ComSpec ?? 'cmd.exe' : 'npm';
  const args = windows ? ['/d', '/s', '/c', `npm.cmd run ${name}`] : ['run', name];
  return run(command, args, tree.workspace, {
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', npm_config_cache: path.join(tree.owner, 'npm-cache') },
  });
};

export const snapshot = async (root) => {
  const entries = [];
  const visit = async (relative) => {
    const full = path.join(root, relative);
    const stat = await fs.lstat(full, { bigint: true });
    const metadata = [relative.replaceAll('\\', '/'), String(stat.mtimeNs), String(stat.mode)];
    if (stat.isSymbolicLink()) {
      entries.push([...metadata, 'link', await fs.readlink(full)]);
    } else if (stat.isDirectory()) {
      entries.push([...metadata, 'directory']);
      for (const name of (await fs.readdir(full)).sort()) { await visit(path.join(relative, name)); }
    } else {
      entries.push([...metadata, 'file', digest(await fs.readFile(full))]);
    }
  };
  await visit('');
  return entries;
};

export const fileDigests = async (root) => (await snapshot(root))
  .filter((entry) => entry[3] === 'file').map((entry) => [entry[0], entry[4]]);

export const generatedFile = async (tree) => {
  const files = await fileDigests(path.join(tree.workspace, 'src/aws/models/sts'));
  const first = files.find(([name]) => name.endsWith('.ts'));
  assert.ok(first, 'STS regeneration must produce TypeScript');
  return path.join(tree.workspace, 'src/aws/models/sts', first[0]);
};

export const linkOutput = async (tree, level) => {
  const outside = path.join(tree.owner, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside bytes must survive');
  if (level === 'file-hardlink') {
    const target = await generatedFile(tree);
    const sentinel = path.join(outside, 'sentinel.ts');
    await fs.writeFile(sentinel, '// outside hardlink sentinel\n');
    await fs.unlink(target);
    await fs.link(sentinel, target);
  } else {
    const target = path.join(tree.workspace, level);
    await fs.rm(target, { recursive: true });
    await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  return outside;
};

export const portableFilename = (name) => {
  assert.equal(typeof name, 'string');
  assert.equal(path.posix.parse(name).root, '');
  assert.equal(path.win32.parse(name).root, '');
  assert.equal(path.posix.extname(name.replaceAll('\\', '/')), '.ts');
  for (const component of name.split(/[\\/]/u)) {
    assert.ok(component.length > 0 && component !== '.' && component !== '..', name);
    assert.ok(!/[<>:"|?*]/u.test(component), `nonportable component: ${name}`);
    assert.ok([...component].every((character) => character.codePointAt(0) >= 32), `control character: ${name}`);
    assert.ok(!/[. ]$/u.test(component), `trailing dot/space: ${name}`);
    assert.ok(!/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?:\.|$)/iu.test(component), `Windows device: ${name}`);
  }
};

export const renameShape = (value, from, to) => {
  if (Array.isArray(value)) { return value.map((child) => renameShape(child, from, to)); }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key === from ? to : key, renameShape(child, from, to)]));
  }
  return value === from ? to : value;
};
