/**
 * Reviewer service entry point. Runs inside the MALT Docker container or as a host daemon started by the extension.
 * Configuration comes from environment variables set by the extension.
 */
import { ClaudeCodeProvider } from './providers/claudeCode';
import { Delegation, DelegatingProvider } from './delegation';
import { createReviewerServer, shutdownReviewerServer } from './server';
import { ReviewService } from './service';
import { ConversationLog } from './conversations';
import { agentCount } from '../shared/reviewerAgents';
import { profilesFromEnv } from '../shared/reviewProfiles';
import { describeError, log } from './log';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
};

const optional = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
};

const main = (): void => {
  const port = Number.parseInt(required('MALT_PORT'), 10);
  const host = optional('MALT_HOST', '127.0.0.1');
  const conversations = new ConversationLog();
  const delegation = new Delegation();
  const service = new ReviewService(
    {
      workspaceRoot: required('MALT_WORKSPACE'),
      agents: agentCount(Number(process.env['MALT_REVIEWER_AGENTS'])),
      profiles: profilesFromEnv(process.env),
      ...(process.env["MALT_MAP_VERIFIER"] === undefined || process.env["MALT_MAP_VERIFIER"] === "" ? {} : { mapVerifier: process.env["MALT_MAP_VERIFIER"] }),
    },
    { claude: new ClaudeCodeProvider(optional('MALT_CLAUDE_PATH', 'claude')), copilot: new DelegatingProvider(delegation, 'copilot') },
    conversations,
  );
  const server = createReviewerServer(service, required('MALT_TOKEN'), conversations, delegation);
  server.listen(port, host, () => {
    log(`listening on ${host}:${String(port)} (provider: ${service.providerName})`);
  });
  const shutdown = (): void => {
    log('shutting down');
    service.agents.close();
    delegation.close();
    shutdownReviewerServer(server);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

try {
  main();
} catch (error: unknown) {
  log(`fatal: ${describeError(error)}`);
  process.exitCode = 1;
}
