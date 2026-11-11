import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { generateModelFiles } from '../aws-model-data.mts';
import { REPOSITORY, cli, cliFixture, digest, fails, fileDigests, generatedFile, linkOutput, npmScript, portableFilename, renameShape, snapshot, succeeds } from './aws-foundation-cli-fixture.mjs';
import { IMPORT_CASES, assertImportDecision, importFixture } from './aws-foundation-import-fixture.mjs';
import { packageFixture } from './aws-foundation-package-fixture.mjs';

// Independent black-box oracles: specs/aws/foundations.md, .agents/AGENTS.md,
// and task-2-tests-brief.md. Implementation modules are executed, never inspected.
test('real model inventory pins the required upstream revisions and original byte digests', async () => {
  const inventory = JSON.parse(await fs.readFile(path.join(REPOSITORY, 'models/aws/sources.json'), 'utf8'));
  for (const file of ['sts.json', 'sqs.json']) {
    const source = inventory.sources.find((entry) => entry.file === file);
    assert.ok(source, file);
    assert.equal(source.repository, 'aws/api-models-aws');
    assert.equal(source.revision, '3cd98287b471c106254abd89279cc87308d38bfd');
    assert.equal(digest(await fs.readFile(path.join(REPOSITORY, 'models/aws', file))), source.sha256);
  }
});

test('CLI regenerates offline without dependencies/tools, deterministically, and check is read-only', async (context) => {
  const tree = await cliFixture(context);
  succeeds(cli(tree));
  const output = path.join(tree.workspace, 'src/aws/models');
  const first = await fileDigests(output);
  for (const service of ['sts', 'sqs']) { assert.ok(first.some(([name]) => name.startsWith(`${service}/`) && name.endsWith('.ts'))); }
  succeeds(cli(tree));
  assert.deepEqual(await fileDigests(output), first);
  const beforeCheck = await snapshot(tree.workspace);
  succeeds(cli(tree, ['--check']));
  assert.deepEqual(await snapshot(tree.workspace), beforeCheck);
  succeeds(cli(tree, ['--check'], true));
  assert.deepEqual(await snapshot(tree.workspace), beforeCheck);
});

test('published npm generation and comparison commands work in the isolated checkout', async (context) => {
  const tree = await cliFixture(context);
  succeeds(npmScript(tree, 'generate:aws-models'));
  const beforeCheck = await snapshot(tree.workspace);
  succeeds(npmScript(tree, 'check:aws-models'));
  assert.deepEqual(await snapshot(tree.workspace), beforeCheck);
});

for (const mutation of ['modified', 'missing', 'stale.ts', 'stale.txt', 'nested/stale.ts']) {
  test(`--check rejects ${mutation} generated output without modifying the tree`, async (context) => {
    const tree = await cliFixture(context);
    succeeds(cli(tree));
    const target = await generatedFile(tree);
    if (mutation === 'modified') { await fs.appendFile(target, '\n// independent drift fixture\n'); }
    else if (mutation === 'missing') { await fs.unlink(target); }
    else {
      const stale = path.join(tree.workspace, 'src/aws/models/sts', mutation);
      await fs.mkdir(path.dirname(stale), { recursive: true });
      await fs.writeFile(stale, 'unexpected generated-tree entry\n');
    }
    const beforeCheck = await snapshot(tree.workspace);
    fails(cli(tree, ['--check']));
    assert.deepEqual(await snapshot(tree.workspace), beforeCheck);
  });
}

for (const service of ['sts', 'sqs']) {
  for (const args of [[], ['--check']]) {
    test(`${args.length === 0 ? 'regeneration' : 'check'} rejects changed ${service} bytes with the original inventory hash`, async (context) => {
      const tree = await cliFixture(context);
      succeeds(cli(tree));
      await fs.appendFile(path.join(tree.workspace, 'models/aws', `${service}.json`), '\n');
      const before = await snapshot(tree.workspace);
      fails(cli(tree, args));
      if (args.length > 0) { assert.deepEqual(await snapshot(tree.workspace), before); }
    });
  }
}

for (const args of [['--unknown'], ['unexpected'], ['--check', 'unexpected'], ['--check=false']]) {
  test(`CLI rejects invalid arguments ${JSON.stringify(args)} without writes`, async (context) => {
    const tree = await cliFixture(context);
    succeeds(cli(tree));
    const before = await snapshot(tree.workspace);
    fails(cli(tree, args));
    assert.deepEqual(await snapshot(tree.workspace), before);
  });
}

for (const level of ['src/aws', 'src/aws/models', 'src/aws/models/sts', 'file-hardlink']) {
  for (const args of [[], ['--check']]) {
    test(`linked output ${level}: ${args.length === 0 ? 'generation' : 'check'} leaves outside sentinels untouched`, async (context) => {
      const tree = await cliFixture(context);
      succeeds(cli(tree));
      const outside = await linkOutput(tree, level);
      const beforeOutside = await snapshot(outside);
      const beforeTree = await snapshot(tree.workspace);
      const result = cli(tree, args);
      assert.deepEqual(await snapshot(outside), beforeOutside, result.output);
      if (args.length > 0) {
        fails(result);
        assert.deepEqual(await snapshot(tree.workspace), beforeTree);
      }
    });
  }
}

test('public generated filenames stay portable for real models and device-like shape identifiers', async () => {
  for (const service of ['sts', 'sqs']) {
    const model = JSON.parse(await fs.readFile(path.join(REPOSITORY, 'models/aws', `${service}.json`), 'utf8'));
    const operation = Object.keys(model.shapes).find((id) => model.shapes[id].type === 'operation');
    assert.ok(operation);
    for (const name of ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9']) {
      const renamed = renameShape(model, operation, `${operation.split('#')[0]}#${name}`);
      const files = generateModelFiles(renamed, service);
      assert.ok(files.size > 0);
      for (const filename of files.keys()) { portableFilename(filename); }
    }
    const colon = renameShape(model, operation, `${operation.split('#')[0]}#data:payload`);
    assert.throws(() => generateModelFiles(colon, service), Error, 'colon paths are not legal Smithy shape IDs');
    const memberShape = Object.values(model.shapes).find((shape) => shape.type === 'structure' && Object.keys(shape.members ?? {}).length > 0);
    const member = Object.values(memberShape.members)[0];
    member.traits = { ...member.traits, 'smithy.api#jsonName': 'data:payload' };
    for (const filename of generateModelFiles(model, service).keys()) { portableFilename(filename); }
  }
});

describe('actual ESLint runtime import boundaries', { concurrency: false }, () => {
  let fixture;
  before(async () => { fixture = await importFixture(); });
  after(async () => { if (fixture) { await fixture.dispose(); } });
  test('all probe paths have clean positive parser/project-service controls', async () => {
    for (const file of new Set(IMPORT_CASES.map((entry) => entry.file))) {
      assert.deepEqual(await fixture.lint(file, 'export const boundaryMarker = 0;\n'), [], file);
    }
  });
  for (const entry of IMPORT_CASES) {
    test(`${entry.allowed ? 'allows' : 'denies'} ${entry.file} ${entry.form} ${entry.specifier}`, async () => {
      assertImportDecision(entry, await fixture.probe(entry));
    });
  }
});

describe('fresh Docker-compiled VSIX boundaries', { concurrency: false }, () => {
  let fixture;
  before(async () => { fixture = await packageFixture(); });
  after(async () => { if (fixture) { await fixture.dispose(); } });
  test('the archive contains byte-identical freshly compiled AWS and shared modules', async () => {
    for (const directory of ['out/aws', 'out/shared']) {
      const files = (await fileDigests(path.join(REPOSITORY, directory))).filter(([name]) => name.endsWith('.js'));
      assert.ok(files.length > 0, directory);
      for (const [name, expected] of files) {
        const packaged = fixture.entries.get(`extension/${directory}/${name}`);
        assert.ok(packaged, `missing compiled module ${directory}/${name}`);
        assert.equal(digest(packaged), expected, name);
      }
    }
  });
  test('the archive ships exactly the four model notices and THIRD_PARTY.md with original bytes', async () => {
    const notices = ['models/aws/LICENSE', 'models/aws/NOTICE', 'models/aws/protocol-tests/LICENSE', 'models/aws/protocol-tests/NOTICE'];
    const packaged = [...fixture.entries.keys()].filter((name) => name.startsWith('extension/models/aws/'));
    assert.deepEqual(packaged.sort(), notices.map((name) => `extension/${name}`).sort());
    for (const name of [...notices, 'THIRD_PARTY.md']) {
      assert.deepEqual(fixture.entries.get(`extension/${name}`), await fs.readFile(path.join(REPOSITORY, name)), name);
    }
  });
  test('the archive excludes raw models, source specifications, protocol sources, tests and scripts', () => {
    const prohibited = [...fixture.entries.keys()].filter((name) => /\/(?:src|specs|scripts|test|tests)\/|\.smithy$|\.test\.[cm]?js$|\/models\/aws\/.*\.json$/iu.test(name));
    assert.deepEqual(prohibited, []);
  });
});
