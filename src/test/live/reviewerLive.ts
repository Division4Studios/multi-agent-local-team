/**
 * Live reviewer test: builds and starts the same hardened Docker reviewer the extension runs (`DockerBackend`), then
 * makes a real call of every kind through the extension's own client and protocol parsers. A build whose reviewer
 * cannot complete these calls (an API-rejected schema, an unparsable answer, a broken image) must not be released.
 *
 * Run by `.github/workflows/reviewer-live.yml` (required before a release is drafted) and locally with
 * `npm run test:live`. Needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the environment. Every call uses
 * MALT_LIVE_MODEL (default `haiku`) at low effort, so a run costs a few cents.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DockerBackend } from '../../backend/dockerBackend';
import { defaultDockerSocket } from '../../backend/dockerApi';
import { ReviewerClient } from '../../review/reviewerClient';
import { gapId } from '../../shared/investigation';
import { ARCHITECTURE_FILE, PROTOCOL_VERSION, STANDARDS_FILE } from '../../shared/protocol';
import type { ReviewRequest, StandardsScan } from '../../shared/protocol';
import { profileFrom, profilesToEnv } from '../../shared/reviewProfiles';
import type { ScanProgress } from '../../shared/scanProgress';

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/** Outcomes that prove the round trip worked although the model reached no verdict; anything else fails the run. */
const INCONCLUSIVE = /remains incomplete|still needs evidence|names no mapped source files/u;

const FILES: Readonly<Record<string, string>> = {
  'CLAUDE.md': '# Rules\n\n- Format money with `formatPrice` from `src/format.ts`; never add another formatter.\n- Keep functions small.\n',
  'src/format.ts': 'export const formatPrice = (cents: number): string => `$${(cents / 100).toFixed(2)}`;\n',
  'src/cart.ts': [
    "import { formatPrice } from './format';",
    'export const cartTotal = (items: readonly number[]): string => formatPrice(items.reduce((sum, item) => sum + item, 0));',
    'export const formatCents = (cents: number): string => `$${(cents / 100).toFixed(2)}`;',
    '',
  ].join('\n'),
};
const BLOCK: ReviewRequest = {
  filePath: 'src/cart.ts', startLine: 0, endLine: 2,
  patch: `@@ -0,0 +1,3 @@\n${(FILES['src/cart.ts'] ?? '').trimEnd().split('\n').map((line) => `+${line}`).join('\n')}`,
};
/** A local rule, a component-context rule (evidence requests) and the injection check (sees project rules). */
const CHECKED_RULES = ['focused-change', 'reuse-existing', 'no-reviewer-manipulation'];

const freePort = async (): Promise<number> => await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => { resolvePort(typeof address === 'object' && address !== null ? address.port : 0); });
  });
});

const credentials = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const value = process.env[name];
    if (value !== undefined && value !== '') { env[name] = value; }
  }
  if (Object.keys(env).length === 0) {
    throw new Error('Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN. The live reviewer test never skips: without it, nothing proves the reviewer works.');
  }
  return env;
};

const liveProfilesEnv = (): Record<string, string> => {
  const profile = profileFrom('check', process.env['MALT_LIVE_MODEL'] ?? 'haiku', 'low');
  return profilesToEnv({ overview: profile, check: profile, consolidation: profile, standards: profile, investigation: profile });
};

const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'malt-live-'));
  for (const [path, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
};

/** Saves a scan the way the extension does, so the reviewer can investigate one of its gaps. */
const saveScan = async (root: string, scan: StandardsScan): Promise<void> => {
  const generatedAt = new Date().toISOString();
  await mkdir(join(root, '.malt'), { recursive: true });
  await writeFile(join(root, STANDARDS_FILE), JSON.stringify({ version: 1, generatedAt, rules: scan.rules, gaps: scan.gaps }));
  await writeFile(join(root, ARCHITECTURE_FILE), JSON.stringify({ version: 1, generatedAt, modules: scan.modules }));
};

interface Run {
  failures: number;
  readonly step: (name: string, call: () => Promise<string>) => Promise<void>;
}
const runner = (): Run => {
  const run: Run = {
    failures: 0,
    step: async (name, call) => {
      const started = Date.now();
      const seconds = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`;
      try {
        out(`ok      ${name} (${seconds()}): ${await call()}`);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        if (INCONCLUSIVE.test(message)) {
          out(`ok      ${name} (${seconds()}): reached the model and back, no verdict: ${message}`);
          return;
        }
        run.failures += 1;
        out(`FAILED  ${name} (${seconds()}): ${message}`);
      }
    },
  };
  return run;
};

const waitForHealth = async (client: ReviewerClient): Promise<string> => {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const health = await client.health();
      if (health.protocolVersion !== PROTOCOL_VERSION) { throw new Error(`protocol ${String(health.protocolVersion)}`); }
      return `${health.provider}, protocol ${String(health.protocolVersion)}`;
    } catch (error: unknown) {
      if (Date.now() > deadline) { throw error; }
      await new Promise((wait) => { setTimeout(wait, 1_000); });
    }
  }
};

const reviewCalls = async (run: Run, client: ReviewerClient): Promise<void> => {
  await run.step('block overview', async () => {
    const response = await client.review(BLOCK);
    return `${String(response.overview.applicable.length)} applicable rules`;
  });
  for (const ruleId of CHECKED_RULES) {
    await run.step(`rule check ${ruleId}`, async () => (await client.check({ ...BLOCK, ruleId })).status);
  }
  await run.step('consolidation', async () => `${String((await client.consolidation({ blocks: [BLOCK] })).length)} findings`);
  await run.step('architecture discussion', async () => {
    const answer = await client.discuss({
      path: BLOCK.filePath, source: FILES['src/cart.ts'] ?? '', context: '{}',
      dialogue: JSON.stringify([{ role: 'developer', text: 'What does this file do, in one sentence?' }]),
    });
    return `${String(answer.what.length)} characters`;
  });
};

const scanCalls = async (run: Run, client: ReviewerClient, root: string): Promise<void> => {
  let scan: StandardsScan | undefined;
  await run.step('standards scan (streamed)', async () => {
    const events: ScanProgress[] = [];
    scan = await client.scanStandards((event) => { events.push(event); });
    if (scan.warnings.length > 0) { throw new Error(`a scan stage failed: ${scan.warnings.join('; ')}`); }
    return `${String(scan.rules.length)} rules, ${String(scan.modules.length)} files mapped, ${String(scan.gaps.length)} gaps, ${String(events.length)} progress events`;
  });
  const gap = scan?.gaps[0];
  if (scan === undefined || gap === undefined) {
    out('skip    gap investigation: the scan found no gap to investigate');
    return;
  }
  await saveScan(root, scan);
  await run.step('gap investigation', async () => (await client.investigateGap(gapId(gap))).verdict);
};

const main = async (): Promise<void> => {
  const env = { ...liveProfilesEnv(), ...credentials() };
  const root = await fixture();
  const backend = new DockerBackend(process.env['MALT_DOCKER_SOCKET'] ?? defaultDockerSocket(), resolve(__dirname, '../../..'), out);
  const run = runner();
  try {
    const endpoint = { port: await freePort(), token: randomBytes(32).toString('hex') };
    await backend.start({ workspaceRoot: root, port: endpoint.port, token: endpoint.token, env });
    const client = new ReviewerClient(endpoint);
    await run.step('reviewer health', async () => await waitForHealth(client));
    if (run.failures === 0) {
      await reviewCalls(run, client);
      await scanCalls(run, client, root);
    }
  } finally {
    if (run.failures > 0) { out(`\nReviewer log:\n${await backend.recentLogs()}`); }
    await backend.stop();
    await rm(root, { recursive: true, force: true });
  }
  out(run.failures === 0 ? '\nLive reviewer test passed.' : `\nLive reviewer test FAILED: ${String(run.failures)} call(s).`);
  process.exitCode = run.failures === 0 ? 0 : 1;
};

main().catch((error: unknown) => {
  out(`Live reviewer test could not run: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
