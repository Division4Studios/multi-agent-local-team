/** Workspace containment by real location: symlinks and junctions are resolved before comparing. */
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';

/** Whether `target` is strictly inside `root` (both absolute, already resolved). */
export const isInsidePath = (root: string, target: string): boolean => {
  const fromRoot = relative(root, target);
  return fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
};

/**
 * Where `file` really is, relative to where `root` really is, if it is inside; otherwise undefined. Both sides are
 * resolved, so links anywhere along either path are followed before comparing. Fails closed: a missing or
 * unreadable path is undefined too.
 *
 * Joining the result onto the root's own path gives the verified file, spelled the way the workspace knows it
 * (e.g. `/var/…` rather than macOS's `/private/var/…`, or a long Windows path rather than its short form).
 */
export const realRelativeInside = async (root: string, file: string): Promise<string | undefined> => {
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
    return isInsidePath(realRoot, realFile) ? relative(realRoot, realFile) : undefined;
  } catch {
    return undefined;
  }
};
