/**
 * The whole-change consolidation check: one reviewer call over the new declarations in every changed block,
 * compared with each other and with the architecture map. Runs on demand, or after new files stop appearing.
 */
import * as vscode from 'vscode';
import type { Finding, ConsolidationRequest, ReviewRequest } from '../shared/protocol';
import type { HunkStore } from './hunkStore';
import { requestFor } from './reviewQueue';

/** Stays well under the reviewer's 1 MB request limit once JSON-escaped. */
const MAX_PATCH_CHARS = 600_000;
const AUTO_DELAY_MS = 30_000;

export interface ConsolidationState {
  readonly status: 'idle' | 'running' | 'done' | 'error';
  readonly findings: readonly Finding[];
  readonly checkedAt?: Date;
  readonly error?: string;
}

export interface ConsolidationClient {
  consolidation: (request: ConsolidationRequest) => Promise<readonly Finding[]>;
}

export class ConsolidationCheck implements vscode.Disposable {
  private current: ConsolidationState = { status: 'idle', findings: [] };
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.changeEmitter.event;
  private timer: NodeJS.Timeout | undefined;
  private readonly store: HunkStore;
  private readonly client: () => ConsolidationClient | undefined;

  public constructor(store: HunkStore, client: () => ConsolidationClient | undefined) {
    this.store = store;
    this.client = client;
  }

  public get state(): ConsolidationState {
    return this.current;
  }

  /** Checks the current change. Does nothing while a check is running or the reviewer is offline. */
  public async run(): Promise<void> {
    const client = this.client();
    if (client === undefined || this.current.status === 'running') {
      return;
    }
    this.set({ status: 'running', findings: this.current.findings });
    try {
      const findings = await client.consolidation({ blocks: this.blocks() });
      this.set({ status: 'done', findings, checkedAt: new Date() });
    } catch (error: unknown) {
      this.set({ status: 'error', findings: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Runs once new files have stopped appearing for a while, so a burst of agent edits costs one call. */
  public schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), AUTO_DELAY_MS);
  }

  public dispose(): void {
    clearTimeout(this.timer);
    this.changeEmitter.dispose();
  }

  private blocks(): ReviewRequest[] {
    const blocks: ReviewRequest[] = [];
    let total = 0;
    for (const tracked of this.store.allHunks()) {
      const request = requestFor(tracked);
      total += request.patch.length;
      if (total > MAX_PATCH_CHARS) {
        break;
      }
      blocks.push(request);
    }
    return blocks;
  }

  private set(state: ConsolidationState): void {
    this.current = state;
    this.changeEmitter.fire();
  }
}
