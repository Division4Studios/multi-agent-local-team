import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { collectCodeSources, collectStandardsSources } from '../../reviewer/standardsSources';
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
    name: 'architecture discovery reads the head of source files, shallowest first, skipping tests and build output',
    run: async (): Promise<void> => {
      const root = await mkdtemp(join(tmpdir(), 'malt-code-'));
      for (const folder of ['src/components', 'src/test', 'node_modules/x', 'out']) {
        await mkdir(join(root, folder), { recursive: true });
      }
      await writeFile(join(root, 'main.py'), 'def main():\n    pass\n');
      await writeFile(join(root, 'src', 'components', 'Modal.tsx'), `export const Modal = 1;\n${'x'.repeat(5_000)}`);
      await writeFile(join(root, 'src', 'components', 'Modal.test.tsx'), 'test');
      await writeFile(join(root, 'src', 'test', 'helper.ts'), 'helper');
      await writeFile(join(root, 'node_modules', 'x', 'index.js'), 'dep');
      await writeFile(join(root, 'out', 'main.js'), 'built');
      await writeFile(join(root, 'README.md'), '# not code');
      const sources = await collectCodeSources(root);
      assert.deepEqual(sources.map((source) => source.path), ['main.py', 'src/components/Modal.tsx']);
      assert.equal(sources[1]?.content.length, 1_500);
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
