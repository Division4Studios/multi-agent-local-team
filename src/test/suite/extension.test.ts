import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { TestCase } from './harness';

const EXTENSION_ID = 'division4studios.malt';
const COMMANDS = [
  'malt.startReviewer',
  'malt.stopReviewer',
  'malt.scanStandards',
  'malt.reviewAll',
  'malt.reviewAgain',
  'malt.revealHunk',
  'malt.showReviewerLogs',
  'malt.setCredentials',
  'malt.clearCredentials',
];

export const tests: readonly TestCase[] = [
  {
    name: 'activates and registers its commands',
    run: async (): Promise<void> => {
      const extension = vscode.extensions.getExtension(EXTENSION_ID);
      if (extension === undefined) {
        assert.fail(`extension ${EXTENSION_ID} should be installed in the test host`);
      }
      await extension.activate();
      const commands = new Set(await vscode.commands.getCommands(true));
      for (const command of COMMANDS) {
        assert.ok(commands.has(command), `missing command ${command}`);
      }
    },
  },
];
