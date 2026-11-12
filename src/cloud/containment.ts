import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { absentFile, realDirectory, sameFile } from '../shared/aws/files';
import { isInsidePath, realRelativeInside } from '../shared/realPath';

/** Validate spelling before creation; walk without following linked components. */
export const containedState = async (workspace: string, state: string, create = false): Promise<string> => {
  if (!isAbsolute(workspace) || isAbsolute(state)) { throw new Error('Local AWS requires a contained state directory.'); }
  const parts = state.split(/[\\/]/u);
  if (parts.some(part => part === '' || part === '.' || part === '..' || part.includes(':') || part.includes('\0'))) {
    throw new Error('Invalid Local AWS state directory.');
  }
  const root = await realDirectory(workspace);
  let path = workspace;
  for (const part of parts) {
    const parent = await realDirectory(path);
    path = join(path, part);
    await ensureDirectory(path, create);
    if (!sameFile(parent.identity, (await realDirectory(parent.path)).identity)) {
      throw new Error('Local AWS state directory changed.');
    }
  }
  if (!sameFile(root.identity, (await realDirectory(workspace)).identity)
    || await realRelativeInside(workspace, path) === undefined) {
    throw new Error('Local AWS state directory is outside the workspace.');
  }
  return await realpath(path);
};

const ensureDirectory = async (path: string, create: boolean): Promise<void> => {
  try { await realDirectory(path); }
  catch (error) {
    if (!create || !absentFile(error)) { throw error; }
    try { await mkdir(path); }
    catch { await realDirectory(path); }
    await realDirectory(path);
  }
};

export const containedAbsoluteState = async (workspace: string, state: string): Promise<string> => {
  if (!isAbsolute(state) || !isInsidePath(workspace, state)) { throw new Error('Invalid Local AWS state path.'); }
  return await containedState(workspace, relative(workspace, state));
};
