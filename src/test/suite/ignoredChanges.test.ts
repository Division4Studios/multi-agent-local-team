import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { GIT_STATUS } from '../../git/gitApi';
import type { GitApi, GitChange, GitRepository } from '../../git/gitApi';
import { ChangeTracker } from '../../review/changeTracker';
import { HunkStore } from '../../review/hunkStore';
import { MemoryStorage, waitFor } from './testUtils';
import type { TestCase } from './harness';

const exerciseExclusions = async (failIgnoreCheck: boolean): Promise<void> => {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) {
    assert.fail('test workspace required');
  }
  const paths = ['visible.ts', 'ignored.ts', '.malt/standards.json', 'nested/.malt/standards.json', 'status-ignored.ts'];
  const files = paths.map((path) => vscode.Uri.joinPath(folder.uri, path));
  const changes: GitChange[] = files.map((uri, index) => ({ uri, status: index === 4 ? GIT_STATUS.ignored : GIT_STATUS.untracked }));
  for (const file of files) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(file, '..'));
    await vscode.workspace.fs.writeFile(file, Buffer.from('export const value = 1;\n'));
  }
  const changed = new vscode.EventEmitter<void>();
  const opened = new vscode.EventEmitter<GitRepository>();
  let ignoreVisible = false;
  let calls = 0;
  const checked: string[] = [];
  const repository: GitRepository = {
    rootUri: folder.uri,
    state: { HEAD: undefined, workingTreeChanges: changes, indexChanges: [], onDidChange: changed.event },
    diffWithHEAD: async () => await Promise.resolve(''),
    checkIgnore: async (candidates) => {
      checked.push(...candidates);
      calls += 1;
      await Promise.resolve();
      if (failIgnoreCheck) {
        throw new Error('Git unavailable');
      }
      return new Set(candidates.filter((path) => path.endsWith('ignored.ts') || ignoreVisible));
    },
  };
  const git: GitApi = { repositories: [repository], onDidOpenRepository: opened.event };
  const store = new HunkStore(new MemoryStorage());
  const tracker = new ChangeTracker(git, folder, store);
  const emitted: string[] = [];
  const subscription = tracker.onDidFindNewHunks((event) => { emitted.push(...event.hunks.map((hunk) => hunk.relativePath)); });
  try {
    await waitFor(() => calls > 0, 'ignore check completed');
    if (!failIgnoreCheck) {
      await waitFor(() => emitted.length > 0, 'allowed file finishes loading');
    }
    assert.deepEqual(emitted, failIgnoreCheck ? [] : ['visible.ts']);
    assert.ok(checked.every((path) => !path.includes('.malt') && !path.endsWith('status-ignored.ts')));
    ignoreVisible = true;
    changed.fire();
    await waitFor(() => calls > 1 && store.allHunks().length === 0, 'new ignore rules remove existing blocks');
  } finally {
    vscode.Disposable.from(subscription, tracker, store, changed, opened).dispose();
  }
};

export const tests: readonly TestCase[] = [
  { name: 'ignored files and generated standards never emit review or auto-open events', run: async (): Promise<void> => { await exerciseExclusions(false); } },
  { name: 'ignore lookup failure never sends candidate files to review', run: async (): Promise<void> => { await exerciseExclusions(true); } },
];
