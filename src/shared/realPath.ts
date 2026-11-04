/** Workspace containment by real location: symlinks and junctions are resolved before comparing. */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

/** Whether `target` is strictly inside `root` (both absolute, already resolved). */
export const isInsidePath = (root: string, target: string): boolean => {
  const fromRoot = relative(root, target);
  return fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
};

/**
 * The real path of `file` if it really lives inside `root`, otherwise undefined. Fails closed: a missing or
 * unreadable path is undefined too.
 */
export const realPathInside = async (root: string, file: string): Promise<string | undefined> => {
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    return isInsidePath(realRoot, realFile) ? realFile : undefined;
  } catch {
    return undefined;
  }
};
