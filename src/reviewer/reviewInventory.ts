/** Fresh repository-wide source inventory; content reads still use the confined workspace reader. */
import { readdir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Dirent } from 'node:fs';
import { realRelativeInside } from '../shared/realPath';
import { isSourceCodePath } from './standardsSources';

const EXCLUDED = new Set(['node_modules', 'out', 'dist', 'build', 'coverage', 'target', 'vendor']);
const MAX_ENTRIES = 30_000;
const MAX_DEPTH = 32;

const eligibleDirectory = (entry: Dirent): boolean =>
  entry.isDirectory() && !entry.name.startsWith('.') && !EXCLUDED.has(entry.name);

const recordFile = (root: string, full: string, entry: Dirent, inventory: ReviewInventory): void => {
  const source = relative(root, full).split('\\').join('/');
  if (entry.isFile() && isSourceCodePath(source)) {
    inventory.paths.push(source);
  }
};

export interface ReviewInventory {
  readonly paths: string[];
  readonly omittedDirectories: string[];
  visited: number;
}

const visit = async (root: string, directory: string, depth: number, inventory: ReviewInventory): Promise<void> => {
  const path = relative(root, directory).split('\\').join('/');
  if (depth > MAX_DEPTH || inventory.visited >= MAX_ENTRIES) {
    inventory.omittedDirectories.push(path);
    return;
  }
  try {
    if (directory !== root && await realRelativeInside(root, directory) === undefined) {
      inventory.omittedDirectories.push(path);
      return;
    }
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      inventory.visited += 1;
      if (inventory.visited > MAX_ENTRIES) {
        inventory.omittedDirectories.push(path);
        break;
      }
      const full = join(directory, entry.name);
      if (eligibleDirectory(entry)) {
        await visit(root, full, depth + 1, inventory);
      } else {
        recordFile(root, full, entry, inventory);
      }
    }
  } catch {
    inventory.omittedDirectories.push(path);
  }
};

export const reviewInventory = async (root: string): Promise<ReviewInventory> => {
  const inventory: ReviewInventory = { paths: [], omittedDirectories: [], visited: 0 };
  const resolved = await realpath(root);
  await visit(resolved, resolved, 0, inventory);
  return inventory;
};
