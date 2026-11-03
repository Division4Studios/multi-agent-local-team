/**
 * Entry point loaded inside the VS Code extension host by @vscode/test-electron.
 * Discovers compiled `*.test.js` files next to this one and runs them with the local harness.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readTestCases, runTestCases } from './harness';

export const run = async (): Promise<void> => {
  const files = readdirSync(__dirname)
    .filter((name) => name.endsWith('.test.js'))
    .sort((a, b) => a.localeCompare(b));

  let failures = 0;
  for (const file of files) {
    process.stdout.write(`${file}\n`);
    const moduleExports: unknown = await import(pathToFileURL(join(__dirname, file)).href);
    failures += await runTestCases(readTestCases(moduleExports, file));
  }

  if (failures > 0) {
    throw new Error(`${String(failures)} test(s) failed`);
  }
  process.stdout.write('All tests passed.\n');
};
