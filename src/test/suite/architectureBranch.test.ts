/** Exercises VS Code's actual Git tree/diff API, including a file absent from the active checkout. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { GitApi, GitRepository } from '../../git/gitApi';
import { compareGraphs } from '../../architecture/graph';
import { headOf, revision } from '../../architecture/sources';
import { MapTracker } from '../../architecture/tracker';
import { waitFor } from './testUtils';
import type { TestCase } from './harness';

interface TestRepository extends GitRepository {
  setConfig: (key: string, value: string) => Promise<void>;
  add: (paths: string[]) => Promise<void>;
  commit: (message: string) => Promise<void>;
  createBranch: (name: string, checkout: boolean) => Promise<void>;
  checkout: (branch: string) => Promise<void>;
  status: () => Promise<void>;
}
interface TestGit extends GitApi {
  init: (uri: vscode.Uri) => Promise<TestRepository | null>;
}
const fixture = async (root: string, git: TestGit): Promise<TestRepository> => {
  const repo = await git.init(vscode.Uri.file(root));
  assert.ok(repo !== null);
  await repo.setConfig('user.name', 'MALT Fixture');
  await repo.setConfig('user.email', 'fixture@example.invalid');
  await repo.setConfig('commit.gpgsign', 'false');
  const baseFile = join(root, 'base.ts');
  await writeFile(baseFile, 'export class Base {}');
  await repo.add([baseFile]);
  await repo.commit('base');
  await repo.status();
  return repo;
};

export const tests: readonly TestCase[] = [{
  name: 'architecture: checkout rebuilds automatically; two pinned branch maps leave HEAD and local edits alone',
  run: async (): Promise<void> => {
    const host = vscode.workspace.workspaceFolders?.[0];
    const extension = vscode.extensions.getExtension<{ getAPI: (version: number) => TestGit }>('vscode.git');
    assert.ok(host !== undefined && extension !== undefined);
    const git = (await extension.activate()).getAPI(1);
    const root = await mkdtemp(join(host.uri.fsPath, 'branch-map-'));
    const folder = { uri: vscode.Uri.file(root), index: 0, name: 'branch-map' };
    const key = randomBytes(32);
    let tracker: MapTracker | undefined;
    try {
      const repo = await fixture(root, git);
      const base = headOf(repo);
      assert.notEqual(base.commit, '');
      tracker = new MapTracker(folder, git, key);
      const active = tracker;
      await waitFor(() => active.snapshot?.commit === base.commit && active.snapshot.nodes.some((n) => n.label === 'Base'), 'initial branch map', 25_000);
      await repo.createBranch('feature/widgets', true);
      const child = join(root, 'child.ts');
      await writeFile(child, "import { Base } from './base';\nexport class Child extends Base {}");
      await repo.add([child]);
      await repo.commit('widget');
      await repo.status();
      const feature = headOf(repo);
      await waitFor(() => active.snapshot?.commit === feature.commit && active.snapshot.nodes.some((n) => n.label === 'Child'), 'feature map', 25_000);
      await repo.checkout(base.branch);
      await repo.status();
      await writeFile(join(root, 'base.ts'), 'export class LocallyEdited {}');
      await waitFor(() => active.snapshot?.branch === base.branch && active.snapshot.nodes.some((n) => n.label === 'LocallyEdited'), 'working tree after checkout', 25_000);
      const before = await revision({ folder, noteKey: key }, repo, base, () => true);
      const after = await revision({ folder, noteKey: key }, repo, feature, () => true);
      const diff = compareGraphs(after, before);
      assert.ok(diff.edges.some((e) => e.kind === 'inherits' && e.status === 'added'));
      assert.ok(diff.nodes.some((n) => n.label === 'Child' && n.status === 'added'));
      assert.equal(before.nodes.some((n) => n.label === 'LocallyEdited'), false);
      assert.deepEqual(headOf(repo), base);
    } finally {
      tracker?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
}];
