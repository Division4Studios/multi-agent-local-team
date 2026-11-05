/** Evidence identity includes unrepresented Git changes and relevant unsaved editor versions. */
import * as vscode from 'vscode';
import { normalize } from 'node:path';
import type { GitRepositoryState } from '../git/gitApi';
import { isInsidePath } from '../shared/realPath';

const uriKey = (uri: vscode.Uri): string => {
  const path = normalize(uri.fsPath);
  return process.platform === 'win32' ? path.toLowerCase() : path;
};

type DocumentState = Pick<vscode.TextDocument, 'uri' | 'version' | 'isDirty'>;
export const changeReviewState = (
  folder: vscode.Uri, files: readonly { readonly path: string }[], state: GitRepositoryState | undefined, documents: readonly DocumentState[],
): { readonly identity: string; readonly dirty: boolean; readonly unrepresented: number } => {
  const represented = new Set(files.map((file) => uriKey(vscode.Uri.joinPath(folder, file.path))));
  const changes = [...(state?.workingTreeChanges ?? []), ...(state?.indexChanges ?? []), ...(state?.untrackedChanges ?? [])];
  const changedPaths = new Set(changes.map((change) => uriKey(change.uri)));
  const dirty = documents.filter((document) => document.isDirty && document.uri.scheme === 'file' && isInsidePath(folder.fsPath, document.uri.fsPath));
  const gitIdentity = changes.map((change) => [uriKey(change.uri), change.status]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const documentIdentity = dirty.map((document) => [uriKey(document.uri), document.version]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { identity: JSON.stringify([state?.HEAD, gitIdentity, documentIdentity]), dirty: dirty.length > 0,
    unrepresented: [...changedPaths].filter((path) => !represented.has(path)).length };
};

/** Starting failure must never silently turn the user's review action into an idle queue. */
export const ensureChangeReviewer = async <T>(client: () => T | undefined, start: () => Promise<void>): Promise<T> => {
  if (client() === undefined) { await start(); }
  const running = client();
  if (running === undefined) { throw new Error('The reviewer could not start. Check MALT reviewer logs before trying again.'); }
  return running;
};
