/**
 * Gap investigations: reading the real code behind a gap (following imports, finding other implementers),
 * verifying every quote against the files, and the end-to-end flow through the reviewer.
 * The fixture mirrors a real report: fax providers that look duplicated from names alone but share one contract.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { collectGapCode, enforceInvestigation, groundEvidence, importCandidates, relativeImports } from '../../reviewer/investigation';
import { gapId, isGapId, parseGapInvestigation } from '../../shared/investigation';
import type { Finding, StandardsDocument } from '../../shared/protocol';
import { findQuoteLines } from '../../editor/findingHighlight';
import { investigationPage } from '../../standards/investigationPage';
import { createReviewerServer } from '../../reviewer/server';
import { ReviewService } from '../../reviewer/service';
import type { StructuredCall } from '../../reviewer/providers/provider';
import { ReviewerClient } from '../../review/reviewerClient';
import { profilesFromEnv } from '../../shared/reviewProfiles';
import type { TestCase } from './harness';

const CONTRACT = [
  'export interface SendFaxInput { to: string; pdf: Buffer }',
  'export interface FaxStatusResult { id: string; status: string }',
  'export interface FaxProvider {',
  '  send(input: SendFaxInput): Promise<FaxStatusResult>;',
  '}',
  '',
].join('\n');
const CONCORD = [
  "import type { FaxProvider, SendFaxInput, FaxStatusResult } from './fax-provider';",
  '',
  'export class ConcordService implements FaxProvider {',
  '  public async send(input: SendFaxInput): Promise<FaxStatusResult> {',
  "    return { id: input.to, status: 'queued' };",
  '  }',
  '}',
  '',
].join('\n');
const ETHERFAX = CONCORD.replace('ConcordService', 'EtherFaxService');

const GAP: Finding = {
  title: 'Fax provider types duplicated across three modules',
  files: ['src/concord-service.ts', 'src/etherfax-service.ts'],
  note: 'SendFaxInput is declared separately in each provider.',
  detail: 'Decide which module owns the contract.',
  anchors: [{ file: 'src/concord-service.ts', symbol: 'SendFaxInput' }],
};

const files = [{ path: 'src/a.ts', content: 'export const add = (a: number, b: number): number =>\n  a + b;\n' }];

const createWorkspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'malt-investigate-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, '.malt'));
  await writeFile(join(root, 'src', 'fax-provider.ts'), CONTRACT);
  await writeFile(join(root, 'src', 'concord-service.ts'), CONCORD);
  await writeFile(join(root, 'src', 'etherfax-service.ts'), ETHERFAX);
  const standards: StandardsDocument = { version: 1, generatedAt: '2026-11-04T00:00:00.000Z', rules: [], gaps: [GAP] };
  await writeFile(join(root, '.malt', 'standards.json'), JSON.stringify(standards));
  const map = { version: 1, generatedAt: standards.generatedAt, modules: [{ path: 'src/fax-provider.ts', purpose: 'Fax contract', exports: ['SendFaxInput', 'FaxProvider'] }] };
  await writeFile(join(root, '.malt', 'architecture.json'), JSON.stringify(map));
  return root;
};

const NOT_A_GAP = {
  verdict: 'not-a-gap',
  confidence: 'high',
  plainSummary: 'Both providers import one shared contract from fax-provider.ts; nothing is duplicated.',
  whatTheCodeDoes: 'fax-provider.ts declares the types; each service imports and implements them.',
  evidence: [
    { file: 'src/concord-service.ts', symbol: 'ConcordService', quote: 'export class ConcordService implements FaxProvider {', observation: 'Implements the shared contract.' },
    { file: 'src/fax-provider.ts', symbol: '', quote: "import type { FaxProvider, SendFaxInput, FaxStatusResult } from './fax-provider';\n  export interface Invented {}", observation: 'Made up.' },
  ],
  counterpoints: 'The scan only saw the names.',
  whyItMatters: 'No risk: the contract has one owner.',
  recommendation: 'No change needed.',
};

const startServer = async (root: string, calls: StructuredCall[]): Promise<{ server: Server; client: ReviewerClient }> => {
  const provider = {
    name: 'fake',
    callStructured: async (call: StructuredCall): Promise<unknown> => {
      calls.push(call);
      return await Promise.resolve(NOT_A_GAP);
    },
  };
  const server = createReviewerServer(new ReviewService({ workspaceRoot: root, profiles: profilesFromEnv({}) }, provider), 'token-0123456789');
  await new Promise<void>((resolvePromise) => {
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { server, client: new ReviewerClient({ port, token: 'token-0123456789' }) };
};

export const tests: readonly TestCase[] = [
  {
    name: 'investigation: imports are followed within the workspace (TS sources imported as .js included)',
    run: (): void => {
      assert.deepEqual(relativeImports("import type { A } from './a';\nexport * from '../b.js';\nconst c = require('./c');\nimport('./d');\nimport x from 'lodash';"), ['./a', '../b.js', './c', './d']);
      const candidates = importCandidates('src/core/x.ts', '../b.js');
      assert.equal(candidates[0], 'src/b.js');
      assert.ok(candidates.includes('src/b.ts'), 'a .js import of a TypeScript source resolves to the .ts file');
      assert.deepEqual(importCandidates('src/x.ts', '../../../etc/passwd'), [], 'imports that leave the workspace are never followed');
    },
  },
  {
    name: 'investigation: reads the gap files, their imports and other exporters, never through a link out of the workspace',
    run: async (): Promise<void> => {
      const root = await createWorkspace();
      const outside = await mkdtemp(join(tmpdir(), 'malt-investigate-outside-'));
      await writeFile(join(outside, 'secret.ts'), 'export const SECRET = 1;');
      await symlink(outside, join(root, 'src', 'linked'), 'junction');
      try {
        const gap = { ...GAP, files: [...GAP.files, 'src/linked/secret.ts'] };
        const modules = [{ path: 'src/fax-provider.ts', purpose: 'p', exports: ['SendFaxInput'] }];
        const code = await collectGapCode(root, gap, modules);
        assert.deepEqual(code.map((file) => file.path).sort(), ['src/concord-service.ts', 'src/etherfax-service.ts', 'src/fax-provider.ts']);
        assert.ok(code.every((file) => !file.content.includes('SECRET')), 'a link out of the workspace is never read');
      } finally {
        await rm(join(root, 'src', 'linked'), { force: true });
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'investigation: only quotes found verbatim in a supplied file survive; unsupported verdicts are low confidence',
    run: (): void => {
      const kept = groundEvidence([
        { file: 'src/a.ts', symbol: 'add', quote: 'export const add = (a: number, b: number): number =>   a + b;', observation: 'ok' },
        { file: 'src/a.ts', symbol: 'add', quote: 'export const add = () => 42;', observation: 'invented code' },
        { file: 'src/other.ts', symbol: '', quote: 'a + b;', observation: 'file not supplied' },
        { file: 'src/a.ts', symbol: '<bad>', quote: 'a + b;', observation: 'bad symbol' },
      ], files);
      assert.deepEqual(kept.map((item) => item.observation), ['ok'], 'whitespace differences are fine, invented code is not');
      const unsupported = enforceInvestigation({ ...NOT_A_GAP, verdict: 'confirmed', evidence: [{ file: 'src/a.ts', symbol: '', quote: 'nope', observation: 'x' }] }, { gapId: 'a'.repeat(24), files });
      assert.equal(unsupported?.confidence, 'low');
      assert.equal(enforceInvestigation({ ...NOT_A_GAP, evidence: [] }, { gapId: 'a'.repeat(24), files })?.confidence, 'high', 'a not-a-gap verdict needs no quote');
      assert.equal(enforceInvestigation({ ...NOT_A_GAP, verdict: 'maybe' }, { gapId: 'a'.repeat(24), files }), undefined);
    },
  },
  {
    name: 'investigation: quotes are located in the file whatever their indentation',
    run: (): void => {
      const text = 'class A {\n  first() {}\n\n  second() {\n    return 1;\n  }\n}\n';
      assert.deepEqual(findQuoteLines(text, 'second() {\nreturn 1;'), { start: 3, end: 4 });
      assert.deepEqual(findQuoteLines(text, 'first() {}\nsecond() {'), { start: 1, end: 3 }, 'blank lines inside the span are skipped');
      assert.equal(findQuoteLines(text, 'third() {}'), undefined);
    },
  },
  {
    name: 'investigation: end to end, the reviewer reads the real code and the verdict is grounded',
    run: async (): Promise<void> => {
      const root = await createWorkspace();
      const calls: StructuredCall[] = [];
      const { server, client } = await startServer(root, calls);
      try {
        const result = await client.investigateGap(gapId(GAP));
        const [call] = calls;
        assert.ok(call !== undefined);
        assert.deepEqual([call.model, call.effort], ['sonnet', 'medium'], 'investigations use their own profile');
        assert.ok(call.userPrompt.includes('export class EtherFaxService implements FaxProvider'), 'the real code is in the prompt');
        assert.ok(call.userPrompt.includes('export interface FaxProvider'), 'the imported contract is followed');
        assert.ok(!call.systemPrompt.includes('SendFaxInput'), 'the system prompt stays static');
        assert.equal(result.verdict, 'not-a-gap');
        assert.deepEqual(result.evidence.map((item) => item.symbol), ['ConcordService'], 'the invented quote was dropped');
        assert.deepEqual([...result.filesRead].sort(), ['src/concord-service.ts', 'src/etherfax-service.ts', 'src/fax-provider.ts']);
        assert.deepEqual(parseGapInvestigation(JSON.parse(JSON.stringify(result))), result, 'survives saving');
        await assert.rejects(client.investigateGap('f'.repeat(24)), /Unknown gap/u, 'only recorded gaps can be investigated');
        await assert.rejects(client.investigateGap('../../etc'), /Invalid investigation request/u);
      } finally {
        server.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'investigation: gap ids are stable content hashes; the page leads with a plain-English verdict',
    run: (): void => {
      assert.ok(isGapId(gapId(GAP)));
      assert.equal(gapId(GAP), gapId({ ...GAP, anchors: [] }), 'anchors do not change the identity');
      assert.notEqual(gapId(GAP), gapId({ ...GAP, note: 'changed' }), 'a changed description is a different gap');
      const result = enforceInvestigation(NOT_A_GAP, { gapId: gapId(GAP), files: [{ path: 'src/concord-service.ts', content: CONCORD }] });
      assert.ok(result !== undefined);
      const page = investigationPage(GAP, result);
      const [summary] = page.groups;
      assert.equal(summary?.heading, 'In plain English');
      assert.equal(summary.items[0]?.title, 'Not a gap (high confidence)');
      const evidence = page.groups.find((group) => group.heading === 'Evidence from the code');
      assert.equal(evidence?.items[0]?.code, 'export class ConcordService implements FaxProvider {', 'evidence shows the quoted code');
    },
  },
];
