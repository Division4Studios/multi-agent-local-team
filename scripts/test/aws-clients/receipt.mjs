import * as fs from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RECEIPT_KIND, ensure } from './config.mjs';

export async function prepareReceipt(file) {
  const parent = dirname(file);
  const physical = await fs.realpath(parent);
  const compare = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  ensure(compare(physical) === compare(resolve(parent)), 'RECEIPT', 'receipt parent must be an existing physical directory');
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (stat) {
    ensure(stat.isFile() && stat.nlink === 1, 'RECEIPT', 'receipt must be a regular unlinked owned file');
    const previous = JSON.parse(await fs.readFile(file, 'utf8'));
    ensure(previous.kind === RECEIPT_KIND, 'RECEIPT', 'refusing to replace a file that is not an acceptance receipt');
  }
  const value = { kind: RECEIPT_KIND, runId: randomUUID(), startedAt: new Date().toISOString(), success: false, phase: 'validation', clients: [] };
  const write = async () => {
    const temporary = `${file}.${value.runId}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
      await handle.close();
      await fs.rename(temporary, file);
    } finally {
      await handle.close();
      await fs.rm(temporary, { force: true });
    }
  };
  await write();
  return { value, write };
}
