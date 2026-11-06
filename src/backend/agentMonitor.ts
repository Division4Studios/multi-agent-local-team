/** Polls agent metadata without sharing prompts or interfering with the service health check. */
import * as vscode from 'vscode';
import type { ReviewerClient } from '../review/reviewerClient';
import type { AgentControl, ReviewerAgent } from '../shared/reviewerAgents';

export class AgentMonitor implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.changes.event;
  private readonly client: () => ReviewerClient | undefined;
  private timer: NodeJS.Timeout | undefined;
  private generation = 0;
  private current: readonly ReviewerAgent[] = [];
  public unavailable = false;

  public constructor(client: () => ReviewerClient | undefined) { this.client = client; }
  public get agents(): readonly ReviewerAgent[] { return this.current; }

  public start(): void { this.stop(); void this.poll(this.generation); }
  public stop(): void {
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.current = [];
    this.unavailable = false;
    this.changes.fire();
  }

  public async control(control: AgentControl): Promise<void> {
    const client = this.client();
    if (client === undefined) { throw new Error('Start the reviewer before managing agents.'); }
    const generation = this.generation;
    const agents = await client.agents(control);
    // Invalidate a poll started before the mutation so it cannot overwrite the new snapshot.
    if (generation === this.generation && client === this.client()) {
      this.generation += 1;
      clearTimeout(this.timer);
      this.update(agents, false);
      void this.poll(this.generation);
    }
  }

  public dispose(): void { this.stop(); this.changes.dispose(); }

  private async poll(generation: number): Promise<void> {
    const client = this.client();
    try {
      if (client !== undefined) {
        const agents = await client.agents();
        if (generation === this.generation && client === this.client()) { this.update(agents, false); }
      }
    } catch {
      if (generation === this.generation) { this.update(this.current, true); }
    }
    if (generation === this.generation) { this.timer = setTimeout(() => { void this.poll(generation); }, 1_000); }
  }

  private update(agents: readonly ReviewerAgent[], unavailable: boolean): void {
    if (this.unavailable !== unavailable || JSON.stringify(this.current) !== JSON.stringify(agents)) {
      this.current = agents;
      this.unavailable = unavailable;
      this.changes.fire();
    }
  }
}
