/** A service-wide pool: every provider call uses one identifiable, cancellable slot. */
import { randomBytes } from 'node:crypto';
import { agentCount } from '../shared/reviewerAgents';
import type { AgentControl, AgentState, ReviewerAgent } from '../shared/reviewerAgents';
import { redactSecrets } from './redact';

const STALL_MS = 60_000;
const identity = (): string => randomBytes(16).toString('hex');

class AgentCancelledError extends Error {}

export interface AgentTask {
  readonly timeoutMs: number;
  readonly agentId: string;
  readonly signal: AbortSignal;
  readonly activity: () => void;
}
interface Slot {
  readonly id: string;
  readonly number: number;
  state: AgentState;
  taskId: string;
  label: string;
  activityAt: number;
  controller: AbortController | undefined;
}
interface Waiting {
  readonly start: (slot: Slot) => void;
  readonly reject: (error: Error) => void;
}

export class AgentPool {
  private readonly slots: Slot[] = [];
  private readonly waiting: Waiting[] = [];
  private closed = false;

  public constructor(count = 2) {
    for (let index = 0; index < agentCount(count); index += 1) { this.add(); }
  }

  public snapshot(now = Date.now()): ReviewerAgent[] {
    return this.slots.map((slot) => ({
      id: slot.id, number: slot.number, taskId: slot.taskId, label: slot.label,
      state: slot.state === 'working' && now - slot.activityAt >= STALL_MS ? 'warning' : slot.state,
    }));
  }

  /** False means a stale identity, task, or transition. Nothing is changed in that case. */
  public control(control: AgentControl): boolean {
    if (this.closed) { return false; }
    if (control.action === 'add') { this.add(); this.pump(); return true; }
    const slot = this.slots.find((candidate) => candidate.id === control.id);
    if (slot?.taskId !== control.taskId) { return false; }
    if (control.action === 'start') {
      return this.startSlot(slot);
    }
    if (control.action === 'cancel' && slot.controller === undefined) { return false; }
    if (control.action === 'stop') { slot.state = 'stopped'; }
    slot.controller?.abort(new AgentCancelledError('Reviewer task cancelled by the user'));
    this.pump();
    return true;
  }

  public async run<T>(label: string, timeoutMs: number, run: (task: AgentTask) => Promise<T>): Promise<T> {
    if (this.closed) { throw new Error('The reviewer is shutting down'); }
    const deadline = Date.now() + timeoutMs;
    return await new Promise<T>((resolve, reject: (error: Error) => void) => {
      const waiting: Waiting = {
        reject: (error) => { clearTimeout(timer); reject(error); },
        start: (slot) => {
          clearTimeout(timer);
          void this.execute(slot, label, run, Math.max(1, deadline - Date.now())).then(resolve, reject);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(waiting);
        if (index >= 0) { this.waiting.splice(index, 1); }
        reject(new Error('Timed out waiting for a reviewer agent'));
      }, timeoutMs);
      this.waiting.push(waiting);
      this.pump();
    });
  }

  public close(): void {
    this.closed = true;
    for (const slot of this.slots) {
      slot.state = 'stopped';
      slot.controller?.abort(new Error('The reviewer is shutting down'));
    }
    this.pump();
  }

  private startSlot(slot: Slot): boolean {
    if (slot.state !== 'stopped' || slot.controller !== undefined) { return false; }
    slot.state = 'idle';
    this.pump();
    return true;
  }

  private failed(slot: Slot, cancelled: boolean): void {
    if (slot.state !== 'stopped') { slot.state = cancelled ? 'idle' : 'error'; }
  }

  private add(): void {
    this.slots.push({ id: identity(), number: this.slots.length + 1, state: 'idle', taskId: '', label: '', activityAt: 0, controller: undefined });
  }

  private pump(): void {
    if (this.closed || this.slots.every((slot) => slot.state === 'stopped')) {
      for (const waiting of this.waiting.splice(0)) { waiting.reject(new Error('No reviewer agents are running')); }
      return;
    }
    for (const slot of this.slots) {
      if (slot.controller === undefined && slot.state !== 'stopped') { this.waiting.shift()?.start(slot); }
    }
  }

  private async execute<T>(slot: Slot, label: string, run: (task: AgentTask) => Promise<T>, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(new Error('Reviewer task timed out')); }, timeoutMs);
    slot.controller = controller;
    slot.taskId = identity();
    slot.label = redactSecrets(label).slice(0, 500);
    slot.state = 'working';
    slot.activityAt = Date.now();
    try {
      const result = await run({ agentId: slot.id, timeoutMs, signal: controller.signal, activity: () => { slot.activityAt = Date.now(); } });
      controller.signal.throwIfAborted();
      slot.state = 'idle';
      return result;
    } catch (error: unknown) {
      this.failed(slot, controller.signal.reason instanceof AgentCancelledError);
      throw error;
    } finally {
      clearTimeout(timer);
      slot.controller = undefined;
      slot.taskId = '';
      slot.label = '';
      this.pump();
    }
  }
}
