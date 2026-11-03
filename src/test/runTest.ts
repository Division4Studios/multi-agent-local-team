import { join } from 'node:path';
import { runTests } from '@vscode/test-electron';

const main = async (): Promise<void> => {
  const extensionDevelopmentPath = join(__dirname, '..', '..');
  const extensionTestsPath = join(__dirname, 'suite', 'index.js');
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ['--disable-extensions'],
  });
};

main().catch((error: unknown) => {
  process.stderr.write(`Extension tests failed: ${String(error)}\n`);
  process.exit(1);
});
