import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { collectStandardsSources } from '../../reviewer/standardsSources';
import { prepareStandardsDirectory } from '../../standards/scanStandards';
import type { TestCase } from './harness';

export const tests: readonly TestCase[] = [
  {
    name: 'standards discovery reads ignored agent instructions but never generated MALT output',
    run: async (): Promise<void> => {
      const root = await mkdtemp(join(tmpdir(), 'malt-standards-'));
      const folders = ['.claude', '.codex', '.agents', '.cursor', '.malt', 'docs/.malt'];
      await writeFile(join(root, '.gitignore'), folders.join('\n'));
      for (const folder of folders) {
        await mkdir(join(root, folder), { recursive: true });
        await writeFile(join(root, folder, 'SKILL.md'), '# Rules\nValidate input.\n');
      }
      const sources = await collectStandardsSources(root);
      assert.deepEqual(sources.map((source) => source.path).sort(), [
        '.agents/SKILL.md', '.claude/SKILL.md', '.codex/SKILL.md', '.cursor/SKILL.md',
      ]);
    },
  },
  {
    name: 'standards output gets a local ignore file without overwriting existing policy',
    run: async (): Promise<void> => {
      const root = await mkdtemp(join(tmpdir(), 'malt-output-'));
      const folder: vscode.WorkspaceFolder = { uri: vscode.Uri.file(root), name: 'fixture', index: 0 };
      await prepareStandardsDirectory(folder);
      const ignore = vscode.Uri.joinPath(folder.uri, '.malt', '.gitignore');
      assert.match(Buffer.from(await vscode.workspace.fs.readFile(ignore)).toString(), /\n\*\n/u);
      await vscode.workspace.fs.writeFile(ignore, Buffer.from('*\n!standards.json\n'));
      await prepareStandardsDirectory(folder);
      assert.equal(Buffer.from(await vscode.workspace.fs.readFile(ignore)).toString(), '*\n!standards.json\n');
    },
  },
];
