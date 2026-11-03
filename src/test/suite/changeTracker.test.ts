/**
 * Regression test for the P2 finding: when HEAD moves (e.g. a partial commit) but the file on disk does not change,
 * the cached diff must be invalidated so committed changes stop being shown and reviewed.
 */
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ChangeTracker } from '../../review/changeTracker';
import { HunkStore } from '../../review/hunkStore';
import type { GitApi, GitRepository } from '../../git/gitApi';
import { MemoryStorage, waitFor } from './testUtils';
import type { TestCase } from './harness';

const MODIFIED = 5;

const patch = (addedLine: string): string =>
  ['diff --git a/tracked.ts b/tracked.ts', '--- a/tracked.ts', '+++ b/tracked.ts', '@@ -1,2 +1,3 @@', ' one', `+${addedLine}`, ' two', ''].join('\n');

export const tests: readonly TestCase[] = [
  {
    name: 'change tracker: recomputes blocks when HEAD moves without a file change',
    run: async (): Promise<void> => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder === undefined) {
        assert.fail('the test host must open a workspace folder');
      }
      const file = vscode.Uri.joinPath(folder.uri, 'tracked.ts');
      await vscode.workspace.fs.writeFile(file, Buffer.from('one\nunstaged\ntwo\n'));

      const onDidChange = new vscode.EventEmitter<void>();
      let currentPatch = patch('committed-later');
      const state = {
        HEAD: { commit: 'commit-1' },
        workingTreeChanges: [{ uri: file, status: MODIFIED }],
        indexChanges: [],
        onDidChange: onDidChange.event,
      };
      const repository: GitRepository = {
        rootUri: folder.uri,
        state,
        diffWithHEAD: async (): Promise<string> => await Promise.resolve(currentPatch),
      };
      const git: GitApi = { repositories: [repository], onDidOpenRepository: new vscode.EventEmitter<GitRepository>().event };
      const store = new HunkStore(new MemoryStorage());
      const tracker = new ChangeTracker(git, folder, store);
      const bodies = (): string => store.hunksFor(file).map((tracked) => tracked.hunk.body).join('\n');

      try {
        await waitFor(() => bodies().includes('+committed-later'), 'initial block tracked');
        state.HEAD = { commit: 'commit-2' };
        currentPatch = patch('unstaged');
        onDidChange.fire();
        await waitFor(() => bodies().includes('+unstaged'), 'blocks recomputed after HEAD moved');
        assert.ok(!bodies().includes('+committed-later'), 'committed block must no longer be shown');
      } finally {
        tracker.dispose();
        store.dispose();
        onDidChange.dispose();
      }
    },
  },
];
