/**
 * Codex, for calls the reviewer delegates (`delegationWorker.ts`), each in its own throwaway container
 * (`src/backend/codexContainer.ts`). Trust boundary: MALT's static system prompt replaces Codex's built-in
 * instructions, and the repository text stays in the nonced data blocks of the prompt, so the separation matches
 * Claude's. Codex enforces the (strict-mode) schema; the reviewer's parsers and policies check the answer as for Claude.
 */
import { CodexContainer, codexEffort } from '../backend/codexContainer';
import type { CodexRequest } from '../backend/codexContainer';
import type { Credentials } from '../backend/credentials';
import { DockerClient, defaultDockerSocket } from '../backend/dockerApi';
import { stripNulls, toStrictSchema } from '../backend/strictSchema';
import { readSettings } from '../config';
import type { DelegatedCall } from '../shared/delegation';
import { AUTO_MODEL } from '../shared/reviewProfiles';
import type { CallRunner } from './delegationWorker';

export const NO_CODEX_KEY = 'No OpenAI API key for Codex. Run "MALT: Set Codex Credentials".';

/** What the container receives: `auto` and `default` leave Codex's own model and effort. */
export const codexRequest = (call: DelegatedCall): CodexRequest => {
  const effort = codexEffort(call.effort);
  return {
    instructions: call.systemPrompt,
    prompt: call.userPrompt,
    schema: toStrictSchema(call.schema),
    ...(call.model === AUTO_MODEL ? {} : { model: call.model }),
    ...(effort === undefined ? {} : { effort }),
  };
};

export interface CodexRunnerOptions {
  readonly extensionRoot: string;
  readonly credentials: Pick<Credentials, 'codexApiKey'>;
  readonly log: (line: string) => void;
}

/** One runner for the window; it follows the Docker socket setting and builds the image once per socket. */
export const createCodexRunner = ({ extensionRoot, credentials, log }: CodexRunnerOptions): CallRunner => {
  let current: { readonly socket: string; readonly container: CodexContainer } | undefined;
  const containerFor = (socket: string): CodexContainer => {
    if (current?.socket !== socket) {
      current = { socket, container: new CodexContainer(new DockerClient(socket), extensionRoot, log) };
    }
    return current.container;
  };
  return async (call, onText, signal) => {
    const apiKey = await credentials.codexApiKey();
    if (apiKey === undefined) {
      throw new Error(NO_CODEX_KEY);
    }
    const setting = readSettings().dockerSocketPath;
    const container = containerFor(setting === '' ? defaultDockerSocket() : setting);
    const output = await container.run(codexRequest(call), { apiKey, timeoutMs: call.timeoutMs, ...(signal === undefined ? {} : { signal }) });
    const answer = stripNulls(output);
    // Codex answers in one piece, so the live log gets the whole answer when it arrives.
    onText(JSON.stringify(answer));
    return answer;
  };
};
