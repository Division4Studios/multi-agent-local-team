// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * MALT lint policy:
 * - Strictest type-aware presets from typescript-eslint.
 * - No warnings: every rule that is on is an error (see `asErrors`), and CI runs with --max-warnings 0.
 * - No inline escape hatches: `eslint-disable` comments are ignored (noInlineConfig) and reported.
 *   Changing a rule means changing this file, which is CODEOWNERS-protected and visible in review.
 */

const NAMING_CONVENTION = [
  { selector: 'default', format: ['camelCase'], leadingUnderscore: 'forbid' },
  { selector: 'import', format: ['camelCase', 'PascalCase'] },
  { selector: 'variable', modifiers: ['const'], format: ['camelCase', 'UPPER_CASE'] },
  { selector: 'typeLike', format: ['PascalCase'] },
  { selector: 'enumMember', format: ['PascalCase'] },
  { selector: 'objectLiteralProperty', format: null },
];

const PROCESS_IMPORTS = [
  { name: 'child_process', message: 'Process execution needs a security review; discuss in an issue first.' },
  { name: 'node:child_process', message: 'Process execution needs a security review; discuss in an issue first.' },
];
const VM_IMPORTS = [
  { name: 'vm', message: 'Dynamic code execution is not allowed.' },
  { name: 'node:vm', message: 'Dynamic code execution is not allowed.' },
];
const NO_VSCODE_IN_REVIEWER = [
  { name: 'vscode', message: 'The reviewer service and shared protocol run outside VS Code.' },
];
const TOOLING_PATTERNS = [
  {
    group: ['minimatch', 'minimatch/*', 'glob', 'glob/*'],
    message: 'Tooling-only package; it must never be imported by extension code.',
  },
];

/** @param {import('eslint').Linter.Config[]} configs */
const asErrors = (configs) =>
  configs.map((config) => {
    if (!config.rules) {
      return config;
    }
    /** @type {import('eslint').Linter.RulesRecord} */
    const rules = {};
    for (const [name, entry] of Object.entries(config.rules)) {
      if (entry === 'warn' || entry === 1) {
        rules[name] = 'error';
      } else if (Array.isArray(entry) && (entry[0] === 'warn' || entry[0] === 1)) {
        rules[name] = ['error', ...entry.slice(1)];
      } else if (entry !== undefined) {
        rules[name] = entry;
      }
    }
    return { ...config, rules };
  });

export default asErrors(
  tseslint.config(
    {
      ignores: ['out/**', 'node_modules/**', '.vscode-test/**', '*.vsix'],
    },
    {
      linterOptions: {
        noInlineConfig: true,
        reportUnusedDisableDirectives: 'error',
        reportUnusedInlineConfigs: 'error',
      },
    },
    js.configs.recommended,
    {
      files: ['**/*.ts', '**/*.mts'],
      extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir: import.meta.dirname,
        },
      },
      rules: {
        // Types must be explicit at module boundaries.
        '@typescript-eslint/explicit-function-return-type': 'error',
        '@typescript-eslint/explicit-module-boundary-types': 'error',
        '@typescript-eslint/explicit-member-accessibility': 'error',

        // No type-system escape hatches.
        '@typescript-eslint/ban-ts-comment': [
          'error',
          {
            'ts-expect-error': true,
            'ts-ignore': true,
            'ts-nocheck': true,
            'ts-check': false,
          },
        ],
        '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
        '@typescript-eslint/no-non-null-assertion': 'error',
        '@typescript-eslint/strict-boolean-expressions': [
          'error',
          {
            allowString: false,
            allowNumber: false,
            allowNullableObject: false,
          },
        ],
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        '@typescript-eslint/prefer-readonly': 'error',
        '@typescript-eslint/promise-function-async': 'error',
        '@typescript-eslint/require-array-sort-compare': 'error',
        '@typescript-eslint/no-import-type-side-effects': 'error',
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/consistent-type-exports': 'error',
        '@typescript-eslint/naming-convention': ['error', ...NAMING_CONVENTION],

        // Security-sensitive patterns.
        'no-eval': 'error',
        'no-implied-eval': 'off',
        '@typescript-eslint/no-implied-eval': 'error',
        'no-new-func': 'error',
        'no-script-url': 'error',
        'no-restricted-imports': ['error', { paths: [...PROCESS_IMPORTS, ...VM_IMPORTS], patterns: TOOLING_PATTERNS }],

        // General correctness and hygiene.
        eqeqeq: ['error', 'always'],
        curly: ['error', 'all'],
        'no-console': 'error',
        'no-debugger': 'error',
        'no-alert': 'error',
        'no-var': 'error',
        'prefer-const': 'error',
        'no-param-reassign': 'error',
        'no-throw-literal': 'off',
        '@typescript-eslint/only-throw-error': 'error',
        'no-return-await': 'off',
        '@typescript-eslint/return-await': ['error', 'always'],
        'no-shadow': 'off',
        '@typescript-eslint/no-shadow': 'error',
        'no-warning-comments': ['error', { terms: ['todo', 'fixme', 'xxx', 'hack'], location: 'anywhere' }],
        'no-empty': ['error', { allowEmptyCatch: false }],
        'default-case-last': 'error',
        'no-else-return': ['error', { allowElseIf: false }],
        'object-shorthand': ['error', 'always'],
        'prefer-template': 'error',
        complexity: ['error', 10],
        'max-depth': ['error', 3],
        'max-params': ['error', 4],
        'max-lines-per-function': ['error', { max: 60, skipBlankLines: true, skipComments: true }],
        'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      },
    },
    {
      // VS Code's Git extension API names its baseline property `HEAD`; we must match that external contract.
      // Exactly that one type-property name, in exactly this file. All other naming rules still apply.
      files: ['src/git/gitApi.ts'],
      rules: {
        '@typescript-eslint/naming-convention': [
          'error',
          { selector: 'typeProperty', filter: { regex: '^HEAD$', match: true }, format: null },
          ...NAMING_CONVENTION,
        ],
      },
    },
    {
      // Approved process execution (security-reviewed): the host reviewer daemon and the Claude Code provider.
      // Every other file still may not import child_process.
      files: ['src/backend/hostBackend.ts', 'src/reviewer/providers/claudeCode.ts'],
      rules: {
        'no-restricted-imports': ['error', { paths: [...VM_IMPORTS, ...NO_VSCODE_IN_REVIEWER], patterns: TOOLING_PATTERNS }],
      },
    },
    {
      // The reviewer service runs outside VS Code (in Docker or as a plain Node process).
      files: ['src/reviewer/**/*.ts', 'src/shared/**/*.ts'],
      ignores: ['src/reviewer/providers/claudeCode.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          { paths: [...PROCESS_IMPORTS, ...VM_IMPORTS, ...NO_VSCODE_IN_REVIEWER], patterns: TOOLING_PATTERNS },
        ],
      },
    },
    {
      // Scripts are run by Node directly (type stripping), so they may log and import .ts files.
      files: ['scripts/**/*.mts'],
      rules: {
        'no-console': 'off',
      },
    },
    {
      files: ['**/*.mjs'],
      languageOptions: {
        globals: { console: 'readonly', process: 'readonly' },
      },
    },
  ),
);
