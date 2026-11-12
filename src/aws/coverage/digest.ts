import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readOrdinary, realDirectory } from '../../shared/aws/files';

const inventory = async (root: string, prefix: string): Promise<string[]> => {
  await realDirectory(join(root, prefix));
  const files: string[] = [];
  for (const name of await readdir(join(root, prefix))) {
    const relative = `${prefix}/${name}`;
    const info = await lstat(join(root, relative));
    if (info.isSymbolicLink()) { throw new Error('Linked runtime inventory entry'); }
    if (info.isDirectory()) { files.push(...await inventory(root, relative)); }
    else if (!info.isFile() || info.nlink !== 1) { throw new Error('Nonregular runtime inventory entry'); }
    else if (name.endsWith('.js')) { files.push(relative); }
  }
  return files;
};
export const runtimeDigest = async (runtimeRoot: string): Promise<string> => {
  const root = (await realDirectory(runtimeRoot)).path;
  const files = [...await inventory(root, 'aws'), ...await inventory(root, 'shared')];
  files.sort((a, b) => a < b ? -1 : Number(a > b));
  const hash = createHash('sha256');
  for (const file of files) {
    const bytes = await readOrdinary(join(root, file));
    if (bytes === undefined) { throw new Error('Runtime inventory changed'); }
    hash.update(file, 'utf8').update('\0').update(bytes).update('\0');
  }
  return hash.digest('hex');
};
