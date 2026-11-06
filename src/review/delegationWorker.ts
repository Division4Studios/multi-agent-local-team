/**
 * Runs the reviewer's delegated calls (`src/reviewer/delegation.ts`) while it is running: long-polls for calls, runs
 * each on its provider (GitHub Copilot through VS Code's Language Model API), streams the answer text for the live
 * log, and posts the answer back. The reviewer built the prompt and validates the answer; this only runs the call.
 */
import type * as vscode from 'vscode';
import { MAX_DELEGATED_RESULT_BYTES } from '../shared/delegation';
import type { DelegatedCall, DelegatedResult } from '../shared/delegation';
import { PROVIDER_LABELS } from '../shared/reviewProfiles';
import type { ProviderId } from '../shared/reviewProfiles';
import { ReviewerHttpError } from './reviewerClient';
import type { ReviewerClient } from './reviewerClient';

/** Runs one call and returns its JSON answer. `onText` receives the answer as it streams (display only). */
export type CallRunner = (call: DelegatedCall, onText: (text: string) => void, signal?: AbortSignal) => Promise<unknown>;

/** Wait after a failed poll (reviewer restarting, network hiccup) before asking again. */
const RETRY_MS = 2_000;
/** Streamed text is sent in batches at most this often, not one request per token. */
const TEXT_FLUSH_MS = 500;

const delay = async (ms: number): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, ms); });
};

/** Collects streamed text and sends it in batches; `flush` sends what is left. Send failures are display-only. */
const textBatcher = (send: (text: string) => Promise<void>): { readonly add: (text: string) => void; readonly flush: () => Promise<void> } => {
  let buffered = '';
  let timer: NodeJS.Timeout | undefined;
  const flush = async (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const text = buffered;
    buffered = '';
    if (text !== '') {
      await send(text).catch(() => undefined);
    }
  };
  return {
    add: (text): void => {
      buffered += text;
      timer ??= setTimeout(() => { void flush(); }, TEXT_FLUSH_MS);
    },
    flush,
  };
};

export class DelegationWorker implements vscode.Disposable {
  private readonly client: () => ReviewerClient | undefined;
  private readonly runners: Partial<Record<ProviderId, CallRunner>>;
  private polling = false;
  private disposed = false;
  private readonly active = new Set<AbortController>();

  public constructor(client: () => ReviewerClient | undefined, runners: Partial<Record<ProviderId, CallRunner>>) {
    this.client = client;
    this.runners = runners;
  }

  /** Starts polling if it isn't already; it stops by itself when the reviewer is no longer running. */
  public start(): void {
    if (this.polling || this.disposed) {
      return;
    }
    this.polling = true;
    void this.poll().finally(() => { this.polling = false; });
  }

  public dispose(): void {
    this.disposed = true;
    for (const controller of this.active) { controller.abort(); }
  }

  private isCurrent(client: ReviewerClient): boolean { return !this.disposed && this.client() === client; }

  private async poll(): Promise<void> {
    for (let client = this.client(); client !== undefined && !this.disposed; client = this.client()) {
      try {
        const calls = await client.takeModelCalls();
        if (!this.isCurrent(client)) { return; }
        for (const call of calls) {
          void this.run(client, call);
        }
      } catch {
        await delay(RETRY_MS);
      }
    }
  }

  private async checkCall(client: ReviewerClient, id: string, controller: AbortController): Promise<void> {
    try {
      if (this.disposed || this.client() !== client || !(await client.activeModelCalls()).includes(id)) { controller.abort(); }
    } catch { controller.abort(); }
  }

  private async run(client: ReviewerClient, call: DelegatedCall): Promise<void> {
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setInterval(() => { void this.checkCall(client, call.id, controller); }, 1_000);
    const text = textBatcher(async (chunk) => { await client.streamModelText({ id: call.id, text: chunk }); });
    let result: DelegatedResult;
    try {
      const runner = this.runners[call.provider];
      if (runner === undefined) {
        throw new Error(`${PROVIDER_LABELS[call.provider]} is not available in this VS Code window`);
      }
      const output = await runner(call, text.add, controller.signal);
      controller.signal.throwIfAborted();
      result = { id: call.id, output };
    } catch (error: unknown) {
      result = { id: call.id, error: error instanceof Error ? error.message : String(error) };
    } finally {
      clearInterval(timer);
      this.active.delete(controller);
    }
    await text.flush();
    await deliver(client, call, result);
  }
}

/**
 * Posts the answer. An answer too large to send, or one the reviewer rejects, settles the call with an explicit
 * error at once rather than leaving it to time out. A 404 means the call already ended (timed out); nothing to do.
 */
export const deliver = async (client: Pick<ReviewerClient, 'answerModelCall'>, call: DelegatedCall, result: DelegatedResult): Promise<void> => {
  const label = PROVIDER_LABELS[call.provider];
  const sized: DelegatedResult = Buffer.byteLength(JSON.stringify(result)) > MAX_DELEGATED_RESULT_BYTES
    ? { id: call.id, error: `${label}'s answer is larger than MALT accepts (${String(MAX_DELEGATED_RESULT_BYTES)} bytes)` }
    : result;
  try {
    await client.answerModelCall(sized);
  } catch (error: unknown) {
    if ((error instanceof ReviewerHttpError && error.status === 404) || 'error' in sized) {
      return;
    }
    const reason = error instanceof Error ? error.message : String(error);
    await client.answerModelCall({ id: call.id, error: `${label} answered, but the answer could not be delivered to the reviewer: ${reason}` }).catch(() => undefined);
  }
};
