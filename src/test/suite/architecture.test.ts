/** Architecture map slicing and new-declaration extraction (pure functions). */
import assert from 'node:assert/strict';
import { architectureSlice, newDeclarations } from '../../reviewer/architecture';
import type { ArchitectureModule } from '../../shared/protocol';
import type { TestCase } from './harness';

const MODULES: ArchitectureModule[] = [
  { path: 'src/components/Modal.tsx', purpose: 'Dialog shell', exports: ['Modal', 'useModal'] },
  { path: 'src/components/Button.tsx', purpose: 'Button', exports: ['Button'] },
  { path: 'src/pages/settings/Profile.tsx', purpose: 'Profile page', exports: ['ProfilePage'] },
  { path: 'server/db/users.py', purpose: 'User queries', exports: ['find_user'] },
];

export const tests: readonly TestCase[] = [
  {
    name: 'architecture slice: name overlap ranks first, neighbours follow, unrelated modules are left out',
    run: (): void => {
      const patch = '@@ -0,0 +1,2 @@\n+export const ConfirmModal = () => <Modal open />;\n context line Button';
      const slice = architectureSlice(MODULES, [{ filePath: 'src/components/ConfirmModal.tsx', patch }], 10);
      assert.deepEqual(slice.map((module) => module.path), ['src/components/Modal.tsx', 'src/components/Button.tsx']);
      assert.equal(architectureSlice(MODULES, [{ filePath: 'src/components/ConfirmModal.tsx', patch }], 1).length, 1);
    },
  },
  {
    name: 'architecture slice: sibling folders count as neighbours',
    run: (): void => {
      const slice = architectureSlice(MODULES, [{ filePath: 'src/pages/billing/Invoice.tsx', patch: '+x' }], 10);
      assert.deepEqual(slice.map((module) => module.path), ['src/pages/settings/Profile.tsx']);
    },
  },
  {
    name: 'new declarations: only added declaration lines, grouped per file',
    run: (): void => {
      const block = (filePath: string, patch: string): { filePath: string; startLine: number; endLine: number; patch: string } =>
        ({ filePath, startLine: 0, endLine: 0, patch });
      const declarations = newDeclarations([
        block('src/a.ts', '@@\n+export function formatDate(d: Date) {\n+  return d;\n-export class Old {}\n context'),
        block('src/a.ts', '@@\n+  export default class UserCard {'),
        block('b.py', '@@\n+def format_date(value):\n+    pass'),
        block('c.ts', '@@\n+const x = 1 + 2'),
      ]);
      assert.deepEqual(declarations, [
        { filePath: 'src/a.ts', lines: ['export function formatDate(d: Date) {', 'export default class UserCard {'] },
        { filePath: 'b.py', lines: ['def format_date(value):'] },
        { filePath: 'c.ts', lines: ['const x = 1 + 2'] },
      ]);
    },
  },
];
