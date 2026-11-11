import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { ESLint } from 'eslint';
import { REPOSITORY, copyRelative, ownedTree } from './aws-foundation-cli-fixture.mjs';

const FORMS = ['import', 'reexport', 'dynamic', 'require'];
const INTERNAL = [
  { file: 'src/reviewer/boundary.ts', own: 'reviewer', denied: ['aws', 'cloud', 'backend'] },
  { file: 'src/aws/boundary.ts', own: 'aws', denied: ['reviewer', 'cloud', 'backend'] },
  { file: 'src/shared/boundary.ts', own: 'shared', denied: ['reviewer', 'aws', 'cloud'] },
  { file: 'src/reviewer/providers/deep/boundary.ts', own: 'reviewer', denied: ['aws'] },
  { file: 'src/aws/gateway/deep/boundary.ts', own: 'aws', denied: ['reviewer'] },
  { file: 'src/shared/aws/deep/boundary.ts', own: 'shared', denied: ['aws'] },
  { file: 'src/extension.ts', own: 'views', denied: ['aws'] },
  { file: 'src/cloud/boundary.ts', own: 'cloud', denied: ['aws'] },
  { file: 'src/views/deep/boundary.ts', own: 'views', denied: ['aws'] },
];
const relativeTarget = (file, group) => {
  const relative = path.posix.relative(path.posix.dirname(file), `src/${group}/boundaryTarget`);
  return relative.startsWith('.') ? relative : `./${relative}`;
};
const probe = (file, form, specifier, allowed) => ({ file, form, specifier, allowed });

const internalCases = () => INTERNAL.flatMap(({ file, own, denied }) => {
  const cases = [];
  for (const form of FORMS) {
    if (form !== 'require') {
      for (const group of new Set([own, 'shared'])) { cases.push(probe(file, form, relativeTarget(file, group), true)); }
    }
    for (const group of denied) { cases.push(probe(file, form, relativeTarget(file, group), false)); }
  }
  return cases;
});

const normalizedCases = () => INTERNAL.slice(0, 3).flatMap(({ file, denied }) => {
  const forbidden = denied[0];
  const shared = path.posix.dirname(relativeTarget(file, 'shared'));
  const blocked = path.posix.dirname(relativeTarget(file, forbidden));
  return FORMS.flatMap((form) => [
    probe(file, form, `${shared}/../${forbidden}/boundaryTarget`, false),
    ...(form === 'require' ? [] : [probe(file, form, `${blocked}/../shared/./boundaryTarget`, true)]),
  ]);
});

const restrictedCases = () => {
  const cases = [];
  for (const { file } of INTERNAL.slice(0, 3)) {
    for (const module of ['vscode', 'child_process', 'node:child_process', 'vm', 'node:vm', 'glob', 'minimatch']) {
      for (const form of FORMS) { cases.push(probe(file, form, module, false)); }
    }
    for (const module of ['glob/sync', 'minimatch/package.json']) { cases.push(probe(file, 'import', module, false)); }
    cases.push(probe(file, 'import', 'node:fs', true));
  }
  cases.push(probe('src/extension.ts', 'import', 'vscode', true));
  return cases;
};

const exceptionCases = () => {
  const cases = [];
  for (const file of ['src/backend/hostBackend.ts', 'src/reviewer/providers/claudeCode.ts', 'scripts/compiler.mts', 'docker/codex/run.mjs']) {
    cases.push(probe(file, 'import', 'node:child_process', true));
    cases.push(probe(file, 'dynamic', 'node:child_process', true));
    for (const form of FORMS) { cases.push(probe(file, form, 'node:vm', false)); }
  }
  for (const file of ['src/backend/other.ts', 'src/reviewer/providers/other.ts', 'scripts/boundary.mts', 'docker/codex/other.mjs']) {
    cases.push(probe(file, 'import', 'node:child_process', false));
  }
  cases.push(probe('src/reviewer/providers/claudeCode.ts', 'import', 'vscode', false));
  return cases;
};

export const IMPORT_CASES = [...internalCases(), ...normalizedCases(), ...restrictedCases(), ...exceptionCases()];

const sourceFor = ({ file, form, specifier }) => {
  const literal = JSON.stringify(specifier);
  if (form === 'import') { return `import ${literal};\n`; }
  if (form === 'reexport') { return `export * from ${literal};\n`; }
  if (form === 'dynamic') {
    const type = file.endsWith('.mjs') ? '' : ': Promise<unknown>';
    return `export const load = async ()${type} => await import(${literal});\n`;
  }
  const type = file.endsWith('.mjs') ? '' : ': unknown';
  return `import { createRequire } from 'node:module';\nconst require = createRequire('/boundary.cjs');\nexport const imported${type} = require(${literal});\n`;
};

export const importFixture = async () => {
  const tree = await ownedTree();
  for (const name of ['eslint.config.mjs', 'package.json', 'tsconfig.json', 'tsconfig.base.json', 'scripts/tsconfig.json']) {
    await copyRelative(tree.workspace, name);
  }
  await fs.symlink(path.join(REPOSITORY, 'node_modules'), path.join(tree.workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const files = new Set(IMPORT_CASES.map(({ file }) => file));
  for (const group of ['aws', 'shared', 'reviewer', 'backend', 'cloud', 'views']) { files.add(`src/${group}/boundaryTarget.ts`); }
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(tree.workspace, file)), { recursive: true });
    await fs.writeFile(path.join(tree.workspace, file), 'export const boundaryMarker = 0;\n');
  }
  const eslint = new ESLint({ cwd: tree.workspace, overrideConfigFile: path.join(tree.workspace, 'eslint.config.mjs') });
  const lint = async (file, source) => {
    const results = await eslint.lintText(source, { filePath: path.join(tree.workspace, file) });
    const messages = results.flatMap((result) => result.messages);
    assert.ok(messages.every((message) => !message.fatal), `parser/project-service failure: ${JSON.stringify(messages)}`);
    return messages;
  };
  return { ...tree, lint, probe: (entry) => lint(entry.file, sourceFor(entry)) };
};

export const assertImportDecision = (entry, messages) => {
  if (entry.allowed) {
    assert.deepEqual(messages, [], `allowed import rejected: ${entry.file} ${entry.form} ${entry.specifier}`);
  } else {
    const policyErrors = messages.filter((item) => item.severity === 2 && /import|require|re-export/iu.test(item.message));
    assert.ok(policyErrors.length > 0, `missing import-policy denial: ${JSON.stringify(entry)}\n${JSON.stringify(messages)}`);
  }
};
