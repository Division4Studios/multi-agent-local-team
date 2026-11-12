import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { isAbsolute, join, parse, sep } from 'node:path';
import { isRecord } from '../guards';

export const absentFile = (error: unknown): boolean => isRecord(error) && error['code'] === 'ENOENT';
export const sameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino;
interface DirectoryRoot { readonly path: string; readonly identity: Stats }
const separator = (character: string | undefined): boolean => character === '/' || (sep === '\\' && character === '\\');
const directorySpelling = (path: string): string => {
  const rootLength = parse(path).root.length;
  let end = path.length;
  // Strip only terminal separators/dot components; preserve native roots and other components.
  while (end > rootLength) {
    if (separator(path[end - 1])) { end -= 1; }
    else if (path[end - 1] === '.' && separator(path[end - 2])) { end -= 1; }
    else { break; }
  }
  return path.slice(0, end);
};
export const realDirectory = async (path: string): Promise<DirectoryRoot> => {
  const root = directorySpelling(path);
  const identity = await lstat(root);
  if (identity.isSymbolicLink() || !identity.isDirectory()) { throw new Error('Invalid or linked directory'); }
  return { path: root, identity };
};
export const ordinaryFile = async (path: string): Promise<Stats | undefined> => {
  let info: Stats;
  try { info = await lstat(path); }
  catch (error) { if (absentFile(error)) { return undefined; } throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) { throw new Error('Invalid linked or nonregular file'); }
  return info;
};
export const readOrdinary = async (path: string): Promise<Buffer | undefined> => {
  const before = await ordinaryFile(path);
  if (before === undefined) { return undefined; }
  const handle = await open(path, 'r');
  try {
    const current = await handle.stat();
    const after = await ordinaryFile(path);
    if (after === undefined || !sameFile(before, current) || !sameFile(current, after) || current.nlink !== 1) {
      throw new Error('File changed while opening');
    }
    return await handle.readFile();
  } finally { await handle.close(); }
};

/** Fixed leaf filenames only; this boundary is shared with the evidence publisher. */
export class FileArea {
  private readonly root: string;
  private readonly identity: Stats;
  public constructor(root: string, identity: Stats) { this.root = root; this.identity = identity; }
  public async path(name: string): Promise<string> {
    if (!/^[A-Za-z0-9_.-]+$/u.test(name) || name === '.' || name === '..') { throw new Error('Invalid state filename'); }
    if (!sameFile(this.identity, (await realDirectory(this.root)).identity)) { throw new Error('State directory ownership changed'); }
    return join(this.root, name);
  }
  public async read(name: string): Promise<Buffer | undefined> { return await readOrdinary(await this.path(name)); }
  public async remove(name: string): Promise<void> {
    const path = await this.path(name);
    if (await ordinaryFile(path) !== undefined) { await unlink(path); }
  }
  public async write(name: string, value: unknown): Promise<void> {
    const destination = await this.path(name);
    await ordinaryFile(destination);
    const temporary = await this.path(`.${name}.${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await writeComplete(handle, value);
      await this.path(name);
      await ordinaryFile(destination);
      await rename(temporary, destination);
    } finally { await removeTemporary(temporary); }
  }
}
const writeComplete = async (handle: FileHandle, value: unknown): Promise<void> => {
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
};
const removeTemporary = async (path: string): Promise<void> => {
  try { await unlink(path); }
  catch (error) { if (!absentFile(error)) { throw error; } }
};
export const fileArea = async (root: string, create = false): Promise<FileArea> => {
  if (!isAbsolute(root)) { throw new Error('State directory must be absolute'); }
  let directory: DirectoryRoot;
  try { directory = await realDirectory(root); }
  catch (error) {
    if (!create || !absentFile(error)) { throw error; }
    const path = directorySpelling(root);
    await mkdir(path, { recursive: true });
    directory = await realDirectory(path);
  }
  return new FileArea(directory.path, directory.identity);
};
