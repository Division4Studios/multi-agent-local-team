/**
 * Minimal test harness for the VS Code extension host. Zero dependencies.
 * Test files export `tests: TestCase[]`; assertions use `node:assert/strict`.
 */
export interface TestCase {
  readonly name: string;
  readonly run: () => Promise<void> | void;
}

const isTestCase = (value: unknown): value is TestCase =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  typeof value.name === 'string' &&
  'run' in value &&
  typeof value.run === 'function';

export const readTestCases = (moduleExports: unknown, file: string): readonly TestCase[] => {
  if (typeof moduleExports !== 'object' || moduleExports === null || !('tests' in moduleExports)) {
    throw new Error(`${file} must export "tests"`);
  }
  const { tests } = moduleExports;
  if (!Array.isArray(tests) || !tests.every(isTestCase)) {
    throw new Error(`${file} must export "tests" as an array of TestCase`);
  }
  return tests;
};

/** Runs every case in order and returns the number of failures. */
export const runTestCases = async (cases: readonly TestCase[]): Promise<number> => {
  let failures = 0;
  for (const testCase of cases) {
    try {
      await testCase.run();
      process.stdout.write(`  ✔ ${testCase.name}\n`);
    } catch (error: unknown) {
      failures += 1;
      process.stdout.write(`  ✖ ${testCase.name}\n    ${String(error)}\n`);
    }
  }
  return failures;
};
