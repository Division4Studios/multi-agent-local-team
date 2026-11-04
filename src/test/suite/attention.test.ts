/** Auto-open must not pull the user away while they are investigating something. */
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { AttentionGuard } from '../../editor/attention';
import type { TestCase } from './harness';

export const tests: readonly TestCase[] = [
  {
    name: 'attention: auto-open waits until the user has been idle for the quiet period',
    run: (): void => {
      let now = 1_000_000;
      const guard = new AttentionGuard(() => 60_000, () => now);
      try {
        assert.equal(guard.allowsAutoOpen(), true, 'idle at start');
        guard.noteUserActivity();
        assert.equal(guard.allowsAutoOpen(), false, 'just clicked something: stay put');
        now += 59_000;
        assert.equal(guard.allowsAutoOpen(), false);
        now += 1_000;
        assert.equal(guard.allowsAutoOpen(), true, 'idle long enough');
      } finally {
        guard.dispose();
      }
    },
  },
  {
    name: 'attention: MALT’s own navigation never counts as the user being busy',
    run: async (): Promise<void> => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder === undefined) {
        assert.fail('the test host must open a workspace folder');
      }
      const file = vscode.Uri.joinPath(folder.uri, 'attention-probe.txt');
      await vscode.workspace.fs.writeFile(file, Buffer.from('one\ntwo\n'));
      const guard = new AttentionGuard(() => 60_000);
      try {
        await guard.navigate(async () => {
          await vscode.window.showTextDocument(file, { preview: true, preserveFocus: true });
        });
        assert.equal(guard.allowsAutoOpen(), true, 'an auto-open must not pause the next auto-open');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await new Promise<void>((resolvePromise) => {
          setTimeout(resolvePromise, 600);
        });
        await vscode.window.showTextDocument(file);
        assert.equal(guard.allowsAutoOpen(), false, 'the user switching files does pause auto-open');
      } finally {
        guard.dispose();
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.workspace.fs.delete(file);
      }
    },
  },
];
