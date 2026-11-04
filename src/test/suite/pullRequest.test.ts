/**
 * Reviewing a pull request: GitHub remotes and API data are untrusted, checkout must never put the user's work at
 * risk, and a checked-out repository must not be able to choose what MALT runs.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { parseGitHubRemote } from '../../github/githubApi';
import { checkOutPullRequest, findGitHubRemote, returnFromPullRequest } from '../../pullRequest/pullRequestCheckout';
import { blocksFromFiles } from '../../pullRequest/pullRequestBlocks';
import type { GitFetchOptions, GitRepository } from '../../git/gitApi';
import { readSettings } from '../../config';
import { waitFor } from './testUtils';
import type { TestCase } from './harness';

const HEAD_SHA = 'a'.repeat(40);

const folder = (): vscode.WorkspaceFolder => {
  const first = vscode.workspace.workspaceFolders?.[0];
  if (first === undefined) {
    assert.fail('the test host must open a workspace folder');
  }
  return first;
};

interface FakeRepository extends GitRepository {
  readonly calls: string[];
}

const fakeRepository = (options: { readonly dirty?: boolean; readonly headAfterCheckout?: string }): FakeRepository => {
  const calls: string[] = [];
  const initialHead: { name?: string; commit?: string } = { name: 'main', commit: 'b'.repeat(40) };
  const state = {
    HEAD: initialHead,
    workingTreeChanges: options.dirty === true ? [{ uri: vscode.Uri.file('/w/a.ts'), status: 5 }] : [],
    indexChanges: [],
    remotes: [
      { name: 'origin', fetchUrl: 'git@github.com:me/fork.git' },
      { name: 'upstream', fetchUrl: 'https://github.com/team/app.git' },
      { name: 'mirror', fetchUrl: 'https://gitlab.com/team/app.git' },
    ],
    onDidChange: new vscode.EventEmitter<void>().event,
  };
  return {
    calls,
    rootUri: vscode.Uri.file('/w'),
    state,
    diffWithHEAD: async (): Promise<string> => await Promise.resolve(''),
    checkIgnore: async (): Promise<Set<string>> => await Promise.resolve(new Set<string>()),
    fetch: async (fetchOptions: GitFetchOptions): Promise<void> => {
      calls.push(`fetch ${fetchOptions.remote ?? ''} ${fetchOptions.ref ?? ''}`);
      await Promise.resolve();
    },
    checkout: async (treeish: string): Promise<void> => {
      calls.push(`checkout ${treeish}`);
      state.HEAD = treeish === 'main' ? { name: 'main', commit: 'b'.repeat(40) } : { commit: options.headAfterCheckout ?? treeish };
      await Promise.resolve();
    },
  };
};

export const tests: readonly TestCase[] = [
  {
    name: 'pull requests: only real github.com remotes are recognized',
    run: (): void => {
      for (const url of ['https://github.com/team/app.git', 'https://github.com/team/app', 'git@github.com:team/app.git', 'ssh://git@github.com/team/app.git', 'https://token@github.com/team/app.git']) {
        assert.deepEqual(parseGitHubRemote(url), { owner: 'team', repo: 'app' }, url);
      }
      for (const url of ['https://github.com.evil.com/team/app.git', 'https://evil.com/github.com/team/app', 'https://github.com/team/app/extra', 'https://github.com/../app', 'https://github.com/team/..', 'file:///github.com/team/app']) {
        assert.equal(parseGitHubRemote(url), undefined, url);
      }
      assert.deepEqual(findGitHubRemote(fakeRepository({})), { remote: 'upstream', repo: { owner: 'team', repo: 'app' } }, 'fork workflows review the upstream repository');
    },
  },
  {
    name: 'pull requests: checkout refuses with uncommitted changes and verifies the exact head commit',
    run: async (): Promise<void> => {
      const dirty = fakeRepository({ dirty: true });
      await assert.rejects(checkOutPullRequest(dirty, 'upstream', { number: 7, headSha: HEAD_SHA }), /uncommitted changes/u);
      assert.deepEqual(dirty.calls, [], 'nothing is fetched or checked out');
      const clean = fakeRepository({});
      const previous = await checkOutPullRequest(clean, 'upstream', { number: 7, headSha: HEAD_SHA });
      assert.deepEqual(clean.calls, [`fetch upstream refs/pull/7/head`, `checkout ${HEAD_SHA}`]);
      assert.deepEqual(previous, { treeish: 'main', label: 'main' });
      await returnFromPullRequest(clean, previous);
      assert.equal(clean.calls.at(-1), 'checkout main');
      const wrongHead = fakeRepository({ headAfterCheckout: 'c'.repeat(40) });
      await assert.rejects(checkOutPullRequest(wrongHead, 'upstream', { number: 7, headSha: HEAD_SHA }), /not at the pull request's head/u);
    },
  },
  {
    name: 'pull requests: finishing refuses (keeping the work) if files were changed on the checkout',
    run: async (): Promise<void> => {
      const repository = fakeRepository({ dirty: true });
      await assert.rejects(returnFromPullRequest(repository, { treeish: 'main', label: 'main' }), /Commit or stash them/u);
      assert.deepEqual(repository.calls, []);
    },
  },
  {
    name: 'pull requests: GitHub patches become blocks; deleted, binary and escaping files are skipped',
    run: async (): Promise<void> => {
      const root = folder();
      const outside = await mkdtemp(join(tmpdir(), 'malt-pr-outside-'));
      await writeFile(join(outside, 'secret.ts'), 'export const secret = 1;');
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root.uri, 'pr-file.ts'), Buffer.from('one\ntwo\nthree\n'));
      await symlink(outside, join(root.uri.fsPath, 'pr-linked'), 'junction');
      try {
        const patch = '@@ -1,2 +1,3 @@\n one\n+two\n three';
        const { blocks, skipped } = await blocksFromFiles(root, root.uri, [
          { filename: 'pr-file.ts', status: 'modified', patch },
          { filename: 'gone.ts', status: 'removed', patch: undefined },
          { filename: 'logo.png', status: 'added', patch: undefined },
          { filename: '../escape.ts', status: 'added', patch },
          { filename: 'pr-linked/secret.ts', status: 'added', patch },
        ]);
        assert.deepEqual(blocks.map((block) => [block.relativePath, block.hunk.startLine]), [['pr-file.ts', 1]]);
        assert.deepEqual(skipped.map((item) => item.file), ['gone.ts', 'logo.png', '../escape.ts', 'pr-linked/secret.ts']);
      } finally {
        await rm(join(root.uri.fsPath, 'pr-linked'), { force: true });
        await rm(join(root.uri.fsPath, 'pr-file.ts'), { force: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'settings: a repository cannot choose the program MALT runs (claudePath is machine-scoped)',
    run: async (): Promise<void> => {
      const settingsFile = vscode.Uri.joinPath(folder().uri, '.vscode', 'settings.json');
      const original = await vscode.workspace.fs.readFile(settingsFile);
      const parsed: unknown = JSON.parse(Buffer.from(original).toString('utf8'));
      const hostile = {
        ...(typeof parsed === 'object' && parsed !== null ? parsed : {}),
        'malt.reviewer.maxConcurrentReviews': 7,
        'malt.reviewer.claudePath': '/tmp/evil-binary',
        'malt.docker.socketPath': '/tmp/evil.sock',
      };
      try {
        await vscode.workspace.fs.writeFile(settingsFile, Buffer.from(JSON.stringify(hostile)));
        // A workspace-scoped control setting proves the file was reloaded, so the assertions below are not vacuous.
        await waitFor(() => readSettings().maxConcurrentReviews === 7, 'workspace settings reloaded', 10_000);
        const settings = readSettings();
        assert.notEqual(settings.claudePath, '/tmp/evil-binary', 'workspace settings cannot set claudePath');
        assert.notEqual(settings.dockerSocketPath, '/tmp/evil.sock', 'workspace settings cannot set the Docker socket');
      } finally {
        await vscode.workspace.fs.writeFile(settingsFile, original);
      }
    },
  },
  {
    name: 'pull requests: real git via the VS Code Git extension: fetch refs/pull/N/head, check out, return',
    run: async (): Promise<void> => {
      await realGitCheckout();
    },
  },
];

/** The parts of the Git extension API this test uses to build real repositories. */
interface TestGitRepository extends GitRepository {
  add: (paths: string[]) => Promise<void>;
  commit: (message: string) => Promise<void>;
  createBranch: (name: string, checkout: boolean) => Promise<void>;
  addRemote: (name: string, url: string) => Promise<void>;
}

interface TestGitApi {
  init: (root: vscode.Uri) => Promise<TestGitRepository | null>;
}

const gitApi = async (): Promise<TestGitApi> => {
  const extension = vscode.extensions.getExtension<{ getAPI: (version: 1) => TestGitApi }>('vscode.git');
  if (extension === undefined) {
    assert.fail('the built-in Git extension is required');
  }
  return (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
};

const initRepository = async (git: TestGitApi, path: string): Promise<TestGitRepository> => {
  // The Git extension runs `git init` with the target as its working directory, so it must exist.
  await mkdir(path);
  const repository = await git.init(vscode.Uri.file(path));
  if (repository === null) {
    assert.fail(`could not init ${path}`);
  }
  return repository;
};

const commitFile = async (repository: TestGitRepository, path: string, content: string, message: string): Promise<string> => {
  await writeFile(path, content);
  await repository.add([path]);
  await repository.commit(message);
  await repository.status?.();
  const commit = repository.state.HEAD?.commit;
  if (commit === undefined) {
    assert.fail('commit has no sha');
  }
  return commit;
};

const realGitCheckout = async (): Promise<void> => {
  // CI runners have no git identity; commits made by the Git extension inherit the extension host's environment.
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'MALT Test',
    GIT_AUTHOR_EMAIL: 'malt@example.invalid',
    GIT_COMMITTER_NAME: 'MALT Test',
    GIT_COMMITTER_EMAIL: 'malt@example.invalid',
  });
  const git = await gitApi();
  // Inside the workspace: the Git extension only opens repositories it can see from the workspace. It also keeps
  // watchers on them (EBUSY on Windows), so they are left for runTest.ts, which deletes the whole test workspace.
  const base = await mkdtemp(join(folder().uri.fsPath, 'malt-pr-git-'));
  const origin = await initRepository(git, join(base, 'origin'));
  await commitFile(origin, join(base, 'origin', 'a.ts'), 'export const a = 1;\n', 'base');
  const branch = origin.state.HEAD?.name ?? 'main';
  await origin.createBranch('feature', true);
  const prSha = await commitFile(origin, join(base, 'origin', 'a.ts'), 'export const a = 2;\n', 'pull request');
  await origin.checkout?.(branch);
  // GitHub exposes every pull request as refs/pull/<n>/head on the base repository.
  await mkdir(join(base, 'origin', '.git', 'refs', 'pull', '7'), { recursive: true });
  await writeFile(join(base, 'origin', '.git', 'refs', 'pull', '7', 'head'), `${prSha}\n`);

  const local = await initRepository(git, join(base, 'local'));
  await commitFile(local, join(base, 'local', 'readme.ts'), 'export {};\n', 'local work');
  await local.addRemote('origin', join(base, 'origin'));
  const before = local.state.HEAD?.name;
  const previous = await checkOutPullRequest(local, 'origin', { number: 7, headSha: prSha });
  assert.equal(local.state.HEAD?.commit, prSha, 'HEAD is exactly the pull request head');
  assert.equal(previous.treeish, before);
  await returnFromPullRequest(local, previous);
  await waitFor(() => local.state.HEAD?.name === before, 'back on the original branch', 10_000);
};
