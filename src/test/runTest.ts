import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTests } from '@vscode/test-electron';

/** A throwaway workspace so tests that need a workspace folder have one; the reviewer never auto-starts in it. */
const createTestWorkspace = async (): Promise<string> => {
  const workspace = await mkdtemp(join(tmpdir(), 'malt-test-workspace-'));
  await mkdir(join(workspace, '.vscode'));
  const settings = { 'malt.reviewer.autoStart': false, 'malt.changes.autoOpen': false, 'malt.changes.autoReview': false };
  await writeFile(join(workspace, '.vscode', 'settings.json'), JSON.stringify(settings));
  return workspace;
};

const main = async (): Promise<void> => {
  const extensionDevelopmentPath = join(__dirname, '..', '..');
  const extensionTestsPath = join(__dirname, 'suite', 'index.js');
  const workspace = await createTestWorkspace();
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspace, '--disable-extensions'],
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`Extension tests failed: ${String(error)}\n`);
  process.exit(1);
});
