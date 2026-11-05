/**
 * Live reviewer test: builds and starts the same hardened Docker reviewer the extension runs (`DockerBackend`), then
 * makes a real call of every kind through the extension's own client and protocol parsers. A build whose reviewer
 * cannot complete these calls (an API-rejected schema, an unparsable answer, a broken image) must not be released.
 *
 * Run by `.github/workflows/reviewer-live.yml` (required before a release is drafted) and locally with
 * `npm run test:live`. Needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the environment. Each call type uses
 * the model and effort MALT ships as its default, so the gate proves the configuration users get; MALT_LIVE_MODEL
 * runs every call on one model at low effort instead (for example `haiku`, for a cheaper local check).
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
import type { Finding, ReviewRequest } from '../../shared/protocol';
import { profileFrom, profilesFromEnv, profilesToEnv } from '../../shared/reviewProfiles';
import type { ScanProgress } from '../../shared/scanProgress';

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

/**
 * Outcomes reached only after the model answered (it asked for evidence MALT could not give): the round trip worked
 * without a verdict. Anything else fails the run, including every error raised before a model call.
 */
const INCONCLUSIVE = /remains incomplete|still needs evidence/u;

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

/** The shipped defaults, or every call on MALT_LIVE_MODEL at low effort. */
const liveProfilesEnv = (): Record<string, string> => {
  const model = process.env['MALT_LIVE_MODEL'];
  if (model === undefined || model === '') {
    return profilesToEnv(profilesFromEnv({}));
  }
  const profile = profileFrom('check', model, 'low');
  return profilesToEnv({ overview: profile, check: profile, consolidation: profile, standards: profile, investigation: profile });
};

/**
 * Writes fixture files. The root stays as mkdtemp makes it, 0700 and private to the host user, like a workspace in
 * a private home folder: on a native Linux engine the reviewer must run as that user to read it (#34), so the CI run
 * on GitHub's Linux runner (UID 1001) is the regression test.
 */
const writeFixture = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
};

/** A known gap over two mapped files, so gap investigation always reaches the model, whatever the scan found. */
const SEEDED_GAP: Finding = {
  title: 'Two money formatters',
  files: ['src/format.ts', 'src/cart.ts'],
  note: 'formatCents in src/cart.ts repeats formatPrice in src/format.ts.',
  detail: 'Decide whether cart code must reuse formatPrice.',
  anchors: [{ file: 'src/format.ts', symbol: 'formatPrice' }, { file: 'src/cart.ts', symbol: 'formatCents' }],
};
/** Saves standards and a map the way the extension does, so the reviewer can look the gap up by id. */
const seedGap = async (root: string): Promise<void> => {
  const generatedAt = new Date().toISOString();
  const modules = [
    { path: 'src/format.ts', purpose: 'Money formatting', exports: ['formatPrice'] },
    { path: 'src/cart.ts', purpose: 'Cart totals', exports: ['cartTotal', 'formatCents'] },
  ];
  await writeFixture(root, {
    [STANDARDS_FILE]: JSON.stringify({ version: 1, generatedAt, rules: [], gaps: [SEEDED_GAP] }),
    [ARCHITECTURE_FILE]: JSON.stringify({ version: 1, generatedAt, modules }),
  });
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
        const result = await call();
        out(`ok      ${name} (${seconds()}): ${result}`);
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
  await run.step('standards scan (streamed)', async () => {
    const events: ScanProgress[] = [];
    const scan = await client.scanStandards((event) => { events.push(event); });
    if (scan.warnings.length > 0) { throw new Error(`a scan stage failed: ${scan.warnings.join('; ')}`); }
    return `${String(scan.rules.length)} rules, ${String(scan.modules.length)} files mapped, ${String(scan.gaps.length)} gaps, ${String(events.length)} progress events`;
  });
  await seedGap(root);
  await run.step('gap investigation', async () => (await client.investigateGap(gapId(SEEDED_GAP))).verdict);
};

const main = async (): Promise<void> => {
  const env = { ...liveProfilesEnv(), ...credentials() };
  const root = await mkdtemp(join(tmpdir(), 'malt-live-'));
  await writeFixture(root, FILES);
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
