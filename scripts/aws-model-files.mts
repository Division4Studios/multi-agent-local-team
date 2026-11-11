import { lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Portable paths only: also exclude Windows devices and alternate data streams. */
export const safeRelativePath = (value: string): string => {
  const components = value.split('/');
  for (const component of components) {
    if (component.length === 0 || /[^A-Za-z0-9_.-]/u.test(component) || component === '.' || component === '..'
      || /[. ]$/u.test(component) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(component)) {
      throw new Error(`Unsafe model file path: ${JSON.stringify(value)}`);
    }
  }
  return value;
};

const checkedEntry = (path: string): ReturnType<typeof lstatSync> | undefined => {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry === undefined) {
    return undefined;
  }
  if (entry.isSymbolicLink() || (!entry.isDirectory() && (!entry.isFile() || entry.nlink > 1))) {
    throw new Error(`Linked or non-regular model path is forbidden: ${path}`);
  }
  return entry;
};

export const checkedDirectory = (root: string, relative: string, create = false): string => {
  let current = root;
  const rootEntry = checkedEntry(current);
  if (rootEntry?.isDirectory() !== true) {
    throw new Error(`Missing model root directory: ${root}`);
  }
  for (const component of safeRelativePath(relative).split('/')) {
    current = join(current, component);
    const entry = checkedEntry(current);
    if (entry !== undefined && !entry.isDirectory()) {
      throw new Error(`Expected model directory: ${current}`);
    }
    if (entry === undefined && create) {
      mkdirSync(current);
    }
  }
  return current;
};

export const readModelFile = (root: string, relative: string): Buffer => {
  const components = safeRelativePath(relative).split('/');
  const parent = components.slice(0, -1).join('/');
  if (parent.length > 0) {
    checkedDirectory(root, parent);
  }
  const path = join(root, relative);
  const entry = checkedEntry(path);
  if (entry?.isFile() !== true) {
    throw new Error(`Missing model file: ${relative}`);
  }
  return readFileSync(path);
};

export const scanModelOutput = (root: string, directory: string): ReadonlyMap<string, Buffer> => {
  const base = checkedDirectory(root, directory);
  const result = new Map<string, Buffer>();
  if (checkedEntry(base) === undefined) {
    return result;
  }
  const pending = [''];
  for (const relative of pending) {
    const parent = join(base, relative);
    for (const name of readdirSync(parent)) {
      const child = safeRelativePath(relative.length === 0 ? name : `${relative}/${name}`);
      const entry = checkedEntry(join(base, child));
      if (entry?.isDirectory() === true) {
        pending.push(child);
      } else {
        result.set(child, readModelFile(base, child));
      }
    }
  }
  return result;
};

export const outputDrift = (expected: ReadonlyMap<string, string>, actual: ReadonlyMap<string, Buffer>): string[] => {
  const problems: string[] = [];
  for (const [name, source] of expected) {
    const content = actual.get(name);
    if (content === undefined) {
      problems.push(`missing ${name}`);
    } else if (!content.equals(Buffer.from(source))) {
      problems.push(`changed ${name}`);
    }
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) {
      problems.push(`stale ${name}`);
    }
  }
  return problems;
};

export const writeModelOutput = (root: string, directory: string, files: ReadonlyMap<string, string>): void => {
  const base = checkedDirectory(root, directory, true);
  const actual = scanModelOutput(root, directory);
  for (const name of actual.keys()) {
    if (!files.has(name)) {
      readModelFile(base, name);
      unlinkSync(join(base, name));
    }
  }
  for (const [name, source] of files) {
    safeRelativePath(name);
    // Generator outputs are flat fixed filenames. Never create data-derived subdirectories.
    if (name.includes('/')) {
      throw new Error(`Unexpected generated model subdirectory: ${name}`);
    }
    checkedDirectory(root, directory);
    const path = join(base, name);
    const entry = checkedEntry(path);
    if (entry !== undefined) {
      if (!entry.isFile()) {
        throw new Error(`Expected generated model file: ${name}`);
      }
      if (readModelFile(base, name).equals(Buffer.from(source))) {
        continue;
      }
      unlinkSync(path);
    }
    writeFileSync(path, source, { flag: 'wx' });
  }
};
