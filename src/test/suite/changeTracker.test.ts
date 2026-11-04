/**
 * Regression test for the P2 finding: when HEAD moves (e.g. a partial commit) but the file on disk does not change,
 * the cached diff must be invalidated so committed changes stop being shown and reviewed.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ChangeTracker } from '../../review/changeTracker';
import { HunkStore } from '../../review/hunkStore';
import type { GitApi, GitRepository } from '../../git/gitApi';
import { MemoryStorage, waitFor } from './testUtils';
import type { TestCase } from './harness';

const MODIFIED = 5;
const UNTRACKED = 7;
const SECRET = 'PRIVATE-KEY-MATERIAL-OUTSIDE-WORKSPACE';

const fakeGit = (repository: GitRepository): GitApi => ({ repositories: [repository], onDidOpenRepository: new vscode.EventEmitter<GitRepository>().event });

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
        checkIgnore: async (): Promise<Set<string>> => await Promise.resolve(new Set<string>()),
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
  {
    name: 'change tracker: never reads a new file through a link that leads outside the workspace',
    run: async (): Promise<void> => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder === undefined) {
        assert.fail('the test host must open a workspace folder');
      }
      const outside = await mkdtemp(join(tmpdir(), 'malt-tracker-outside-'));
      await writeFile(join(outside, 'id_rsa'), SECRET);
      const root = folder.uri.fsPath;
      const control = vscode.Uri.joinPath(folder.uri, 'control-new.ts');
      await vscode.workspace.fs.writeFile(control, Buffer.from('export const ok = 1;\n'));
      await symlink(outside, join(root, 'escape-dir'), 'junction');
      const throughJunction = vscode.Uri.file(join(root, 'escape-dir', 'id_rsa'));
      // File symlinks need privileges on some Windows machines; the junction case always runs.
      const fileLink = vscode.Uri.file(join(root, 'escape-file'));
      const fileLinkCreated = await symlink(join(outside, 'id_rsa'), fileLink.fsPath, 'file').then(() => true, () => false);
      const untracked = [control, throughJunction, ...(fileLinkCreated ? [fileLink] : [])];
      const repository: GitRepository = {
        rootUri: folder.uri,
        state: {
          HEAD: { commit: 'c' },
          workingTreeChanges: untracked.map((uri) => ({ uri, status: UNTRACKED })),
          indexChanges: [],
          onDidChange: new vscode.EventEmitter<void>().event,
        },
        diffWithHEAD: async (): Promise<string> => await Promise.resolve(''),
        checkIgnore: async (): Promise<Set<string>> => await Promise.resolve(new Set<string>()),
      };
      const store = new HunkStore(new MemoryStorage());
      const tracker = new ChangeTracker(fakeGit(repository), folder, store);
      try {
        await waitFor(() => store.hunksFor(control).length > 0, 'the ordinary new file is tracked');
        await new Promise<void>((resolvePromise) => {
          setTimeout(resolvePromise, 800);
        });
        assert.equal(store.hunksFor(throughJunction).length, 0, 'a file reached through a linked folder is never read');
        assert.equal(store.hunksFor(fileLink).length, 0, 'a symlinked file is never read');
        assert.ok(store.allHunks().every((tracked) => !tracked.hunk.body.includes(SECRET)), 'the outside file never enters a review');
      } finally {
        tracker.dispose();
        store.dispose();
        await rm(join(root, 'escape-dir'), { force: true });
        await rm(fileLink.fsPath, { force: true });
        await rm(control.fsPath, { force: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
  },
];
