/** Agent identities and controls crossing the authenticated reviewer boundary. */
import { isRecord, parseArray } from './guards';

export type AgentState = 'idle' | 'working' | 'warning' | 'error' | 'stopped';
export type AgentHealth = 'green' | 'yellow' | 'red';
export interface ReviewerAgent {
  readonly id: string;
  readonly number: number;
  readonly state: AgentState;
  readonly taskId: string;
  readonly label: string;
}
export type AgentControl = { readonly action: 'add' } | {
  readonly action: 'cancel' | 'stop' | 'start';
  readonly id: string;
  /** Compare against the observed task so a stale menu cannot cancel newer work. Empty when idle. */
  readonly taskId: string;
};

export const isAgentId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
const isAgentState = (value: unknown): value is AgentState => ['idle', 'working', 'warning', 'error', 'stopped'].some((state) => state === value);
const isAgentNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isTaskId = (value: unknown): value is string => value === '' || isAgentId(value);
export const agentCount = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 2;

export const parseReviewerAgent = (value: unknown): ReviewerAgent | undefined => {
  if (!isRecord(value)) { return undefined; }
  const { id, number, state, taskId, label } = value;
  const valid = isAgentId(id) && isAgentNumber(number) && isTaskId(taskId);
  if (!valid || typeof label !== 'string' || label.length > 500) { return undefined; }
  return isAgentState(state)
    ? { id, number, state, taskId, label } : undefined;
};

export const parseReviewerAgents = (value: unknown): ReviewerAgent[] | undefined => {
  const agents = parseArray(value, parseReviewerAgent);
  return new Set(agents?.map((agent) => agent.id)).size === agents?.length ? agents : undefined;
};

export const parseAgentControl = (value: unknown): AgentControl | undefined => {
  if (!isRecord(value)) { return undefined; }
  const { action, id, taskId } = value;
  if (action === 'add') { return Object.keys(value).length === 1 ? { action } : undefined; }
  return (action === 'cancel' || action === 'stop' || action === 'start') && isAgentId(id) && isTaskId(taskId)
    ? { action, id, taskId } : undefined;
};

/** Idle/stopped slots are neutral; the empty pool is healthy. A partial failure is a warning. */
export const agentsHealth = (agents: readonly ReviewerAgent[]): AgentHealth => {
  const active = agents.filter((agent) => agent.state !== 'idle' && agent.state !== 'stopped');
  if (active.length === 0) { return 'green'; }
  if (agents.every((agent) => agent.state === 'error')) { return 'red'; }
  return active.some((agent) => agent.state === 'error' || agent.state === 'warning') ? 'yellow' : 'green';
};
