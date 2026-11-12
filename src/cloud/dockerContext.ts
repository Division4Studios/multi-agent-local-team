import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createTar } from '../backend/tar';
import type { TarEntry } from '../backend/tar';
import { absentFile } from '../shared/aws/files';

const readNotice = async (root: string, name: string): Promise<Buffer> => {
  try { return await readFile(join(root, name)); }
  catch (error) {
    // VSCE normalizes the root license name in installed extensions.
    if (name === 'LICENSE' && absentFile(error)) { return await readFile(join(root, 'LICENSE.txt')); }
    throw error;
  }
};

/** Only installed runtime JS and the exact receipt/notices, with fixed archive names and metadata. */
export const awsBuildContext = async (extensionRoot: string): Promise<Buffer> => {
  const entries: TarEntry[] = [{ name: 'Dockerfile', data: await readFile(join(extensionRoot, 'docker', 'aws', 'Dockerfile')) }];
  const out = join(extensionRoot, 'out');
  for (const folder of ['aws', 'shared']) {
    const files = await readdir(join(out, folder), { recursive: true, withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && file.name.endsWith('.js') && !file.name.endsWith('.test.js')) {
        const path = join(file.parentPath, file.name);
        entries.push({ name: relative(out, path).split('\\').join('/'), data: await readFile(path) });
      }
    }
  }
  entries.push({ name: 'aws/test-evidence.json', data: await readFile(join(out, 'aws', 'test-evidence.json')) });
  for (const name of ['LICENSE', 'THIRD_PARTY.md', 'models/aws/LICENSE', 'models/aws/NOTICE', 'models/aws/protocol-tests/LICENSE', 'models/aws/protocol-tests/NOTICE']) {
    // Keep the root notice's archive path visibly within the notice inventory too.
    entries.push({ name: name === 'THIRD_PARTY.md' ? 'notices/THIRD_PARTY.md' : name, data: await readNotice(extensionRoot, name) });
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return createTar(entries);
};
export const awsHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
