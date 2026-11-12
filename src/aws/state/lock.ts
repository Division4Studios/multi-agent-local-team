import { randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { ordinaryFile, sameFile } from '../../shared/aws/files';
import type { FileArea } from '../../shared/aws/files';

export const acquireLock = async (area: FileArea): Promise<() => Promise<void>> => {
  const path = await area.path('.lock');
  const handle = await open(path, 'wx', 0o600).catch(() => { throw new Error('State lock already owned or unavailable'); });
  const identity = await handle.stat();
  const owner = randomUUID();
  try { await handle.writeFile(owner, 'utf8'); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(path); throw error; }
  await handle.close();
  return async (): Promise<void> => {
    const current = await ordinaryFile(await area.path('.lock'));
    if (current === undefined || !sameFile(identity, current)) { throw new Error('State lock ownership changed'); }
    if ((await area.read('.lock'))?.toString('utf8') !== owner) { throw new Error('State lock ownership changed'); }
    await area.remove('.lock');
  };
};
