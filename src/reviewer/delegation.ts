/**
 * Delegated calls: the reviewer builds the prompt and validates the answer as for any call, but a provider only the
 * extension can reach (GitHub Copilot) runs it there. The extension long-polls `GET /model-calls`, runs each call,
 * and posts the answer to `POST /model-calls/result`. Calls flow over the reviewer's existing authenticated port, so
 * the reviewer never connects out, and it works the same in Docker and on the host.
 */
import { randomUUID } from 'node:crypto';
import type { DelegatedCall, DelegatedResult } from '../shared/delegation';
import { PROVIDER_LABELS } from '../shared/reviewProfiles';
import type { ProviderId } from '../shared/reviewProfiles';
import type { ReviewProvider, StructuredCall } from './providers/provider';

/** More waiting calls than this means nothing is answering them; new ones fail rather than pile up. */
export const MAX_WAITING = 64;

interface Pending {
  readonly call: DelegatedCall;
  readonly settle: (result: DelegatedResult) => void;
  readonly onText?: (text: string) => void;
  readonly onActivity?: () => void;
  taken: boolean;
}

export class Delegation {
  private readonly pending = new Map<string, Pending>();
  private readonly waiters = new Set<() => void>();
  private closed = false;

  /** Queues a call for the extension and waits for its answer, failing at the call's own timeout. */
  public async run(provider: ProviderId, call: StructuredCall): Promise<unknown> {
    if (this.closed) {
      throw new Error('The reviewer is shutting down');
    }
    if (this.pending.size >= MAX_WAITING) {
      throw new Error(`${PROVIDER_LABELS[provider]}: too many calls are waiting for the MALT extension to answer`);
    }
    const id = randomUUID();
    const delegated: DelegatedCall = {
      id, provider, model: call.model, systemPrompt: call.systemPrompt, userPrompt: call.userPrompt, schema: call.schema, timeoutMs: call.timeoutMs,
    };
    const result = await new Promise<DelegatedResult>((settle) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        settle({ id, error: `${PROVIDER_LABELS[provider]} did not answer within ${String(Math.round(call.timeoutMs / 1000))} s` });
      }, call.timeoutMs);
      this.pending.set(id, {
        call: delegated,
        settle: (answer) => { clearTimeout(timer); settle(answer); },
        ...(call.onText === undefined ? {} : { onText: call.onText }),
        ...(call.onActivity === undefined ? {} : { onActivity: call.onActivity }),
        taken: false,
      });
      this.wake();
    });
    if ('error' in result) {
      throw new Error(result.error);
    }
    return result.output;
  }

  /** Calls not yet handed out, waiting up to `waitMs` for one to arrive. Each call is handed out once. */
  public async take(waitMs: number): Promise<DelegatedCall[]> {
    if (!this.closed && !this.hasWaiting()) {
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        this.waiters.add(done);
      });
    }
    const waiting = [...this.pending.values()].filter((pending) => !pending.taken);
    for (const pending of waiting) {
      pending.taken = true;
    }
    return waiting.map((pending) => pending.call);
  }

  /** Delivers an answer. False if the call is unknown, was never handed out, or has already ended (timed out). */
  public settle(result: DelegatedResult): boolean {
    const pending = this.pending.get(result.id);
    if (pending?.taken !== true) {
      return false;
    }
    this.pending.delete(result.id);
    pending.settle(result);
    return true;
  }

  /** Answer text as it streams in (live log, scan activity). False for an unknown or finished call. */
  public text(id: string, text: string): boolean {
    const pending = this.pending.get(id);
    if (pending?.taken !== true) {
      return false;
    }
    pending.onActivity?.();
    pending.onText?.(text);
    return true;
  }

  /** On shutdown: waiting calls fail, and pollers return at once. */
  public close(): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      pending.settle({ id, error: 'The reviewer is shutting down' });
    }
    this.pending.clear();
    this.wake();
  }

  private hasWaiting(): boolean {
    return [...this.pending.values()].some((pending) => !pending.taken);
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) {
      waiter();
    }
  }
}

/** A provider whose calls the extension runs. */
export class DelegatingProvider implements ReviewProvider {
  public readonly name: string;
  private readonly delegation: Delegation;
  private readonly provider: ProviderId;

  public constructor(delegation: Delegation, provider: ProviderId) {
    this.delegation = delegation;
    this.provider = provider;
    this.name = provider;
  }

  public async callStructured(call: StructuredCall): Promise<unknown> {
    return await this.delegation.run(this.provider, call);
  }
}
