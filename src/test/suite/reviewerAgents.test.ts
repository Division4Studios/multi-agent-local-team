import assert from 'node:assert/strict';
import { AgentPool } from '../../reviewer/agentPool';
import type { AgentTask } from '../../reviewer/agentPool';
import { agentCount, agentsHealth, parseAgentControl, parseReviewerAgent } from '../../shared/reviewerAgents';
import type { AgentState, ReviewerAgent } from '../../shared/reviewerAgents';
import { ConversationLog } from '../../reviewer/conversations';
import { parseConversationEvent } from '../../shared/conversation';
import { Delegation } from '../../reviewer/delegation';
import { ClaudeCodeProvider } from '../../reviewer/providers/claudeCode';
import type { StructuredCall } from '../../reviewer/providers/provider';
import type { TestCase } from './harness';

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let finish = (): void => { throw new Error('Not initialized'); };
  const promise = new Promise<void>((resolve) => { finish = resolve; });
  return { promise, resolve: finish };
};
const snapshot = (pool: AgentPool, index = 0): ReviewerAgent => {
  const agent = pool.snapshot()[index];
  assert.ok(agent !== undefined);
  return agent;
};
const waitForCancel = async (task: AgentTask): Promise<void> => {
  task.signal.throwIfAborted();
  await new Promise<void>((resolve) => { task.signal.addEventListener('abort', () => { resolve(); }, { once: true }); });
};
const CALL: StructuredCall = { model: 'test', effort: 'low', timeoutMs: 5_000, systemPrompt: 'static', userPrompt: 'data', schema: {} };

export const tests: readonly TestCase[] = [
  {
    name: 'agents: two slots by default, queue waits, and adding capacity starts waiting work',
    run: async (): Promise<void> => {
      const pool = new AgentPool();
      const gate = deferred();
      let started = 0;
      const calls = Array.from({ length: 3 }, async () => { await pool.run('check', 1_000, async () => { started += 1; await gate.promise; }); });
      try {
        assert.equal(started, 2);
        assert.equal(pool.snapshot().length, 2);
        pool.control({ action: 'add' });
        assert.equal(started, 3);
        for (let count = 0; count < 70; count += 1) { pool.control({ action: 'add' }); }
        assert.equal(pool.snapshot().length, 73, 'no fixed cap of eight or sixty-four');
      } finally { gate.resolve(); await Promise.all(calls); pool.close(); }
    },
  },
  {
    name: 'agents: cancellation rejects late success, preserves other work, and stale actions cannot cancel new work',
    run: async (): Promise<void> => {
      const pool = new AgentPool();
      const other = deferred();
      const cancelled = assert.rejects(pool.run('cancel me', 1_000, waitForCancel), /cancelled/u);
      const unaffected = pool.run('leave me', 1_000, async () => { await other.promise; return 'ok'; });
      const first = snapshot(pool);
      assert.ok(pool.control({ action: 'cancel', id: first.id, taskId: first.taskId }));
      await cancelled;
      assert.equal(snapshot(pool, 1).state, 'working');
      const next = assert.rejects(pool.run('new task', 1_000, waitForCancel), /cancelled/u);
      assert.equal(pool.control({ action: 'cancel', id: first.id, taskId: first.taskId }), false);
      const current = snapshot(pool);
      assert.ok(pool.control({ action: 'stop', id: current.id, taskId: current.taskId }));
      await next;
      assert.equal(snapshot(pool).state, 'stopped');
      assert.ok(pool.control({ action: 'start', id: current.id, taskId: '' }));
      assert.equal(snapshot(pool).state, 'idle');
      other.resolve();
      assert.equal(await unaffected, 'ok');
      pool.close();
    },
  },
  {
    name: 'agents: warnings follow activity, failures remain visible, and idle pools aggregate green',
    run: async (): Promise<void> => {
      const pool = new AgentPool(1);
      const gate = deferred();
      let activity = (): void => undefined;
      const work = pool.run('task', 1_000, async (task) => { activity = task.activity; await gate.promise; });
      assert.equal(pool.snapshot(Date.now() + 61_000)[0]?.state, 'warning');
      activity();
      assert.equal(snapshot(pool).state, 'working');
      gate.resolve(); await work;
      assert.equal(snapshot(pool).state, 'idle');
      await assert.rejects(pool.run('failure', 1_000, async () => { await Promise.resolve(); throw new Error('failure'); }));
      assert.equal(agentsHealth(pool.snapshot()), 'red');
      const agent = snapshot(pool);
      const states = (...values: AgentState[]): ReviewerAgent[] => values.map((state) => ({ ...agent, state }));
      assert.equal(agentsHealth([]), 'green');
      assert.equal(agentsHealth(states('idle', 'stopped')), 'green');
      assert.equal(agentsHealth(states('working', 'idle')), 'green');
      assert.equal(agentsHealth(states('working', 'warning')), 'yellow');
      assert.equal(agentsHealth(states('working', 'error')), 'yellow');
      assert.equal(agentsHealth(states('error', 'error')), 'red');
      assert.equal(agentsHealth(states('error', 'idle')), 'yellow');
      pool.close();
    },
  },
  {
    name: 'agents: queued deadlines and stopping every agent settle requests without starting them',
    run: async (): Promise<void> => {
      const pool = new AgentPool(1);
      const active = assert.rejects(pool.run('busy', 1_000, waitForCancel), /cancelled/u);
      await assert.rejects(pool.run('expires', 5, async () => { await Promise.resolve(); assert.fail('expired task started'); }), /Timed out/u);
      const queued = assert.rejects(pool.run('queued', 1_000, async () => { await Promise.resolve(); assert.fail('stopped task started'); }), /No reviewer agents/u);
      const agent = snapshot(pool);
      pool.control({ action: 'stop', id: agent.id, taskId: agent.taskId });
      await Promise.all([active, queued]);
      await assert.rejects(pool.run('no slots', 1_000, async () => { await Promise.resolve(); }), /No reviewer agents/u);
      pool.close();
      assert.equal(pool.control({ action: 'add' }), false);
    },
  },
  {
    name: 'agents: identity metadata survives every log event and malformed controls fail closed',
    run: (): void => {
      const log = new ConversationLog();
      const pool = new AgentPool();
      const agent = snapshot(pool);
      const call = log.begin('test', { model: 'test', effort: 'low', agentId: agent.id }, 'prompt');
      call.text('hello '); call.end();
      assert.ok(log.recent().every((event) => event.agentId === agent.id));
      for (const event of log.recent()) {
        assert.deepEqual(parseConversationEvent(event), event);
        assert.equal(parseConversationEvent({ ...event, agentId: '../../file' }), undefined);
      }
      assert.deepEqual(parseReviewerAgent(agent), agent);
      assert.equal(parseAgentControl({ action: 'cancel', id: agent.id }), undefined);
      assert.equal(parseAgentControl({ action: 'execute', id: agent.id, taskId: '' }), undefined);
      assert.equal(parseAgentControl({ action: 'add', command: 'arbitrary' }), undefined);
      for (const bad of [NaN, Infinity, 0, -1, 1.5, '4']) { assert.equal(agentCount(bad), 2); }
      assert.equal(agentCount(100), 100);
      pool.close();
    },
  },
  {
    name: 'agents: delegated cancellation waits for the runner acknowledgement and discards late output',
    run: async (): Promise<void> => {
      const delegation = new Delegation();
      const controller = new AbortController();
      const result = assert.rejects(delegation.run('copilot', { ...CALL, signal: controller.signal }), /cancelled/u);
      const [call] = await delegation.take(0);
      assert.ok(call !== undefined);
      controller.abort();
      assert.deepEqual(delegation.active(), []);
      assert.equal(delegation.text(call.id, 'late text'), false);
      assert.equal(delegation.settle({ id: call.id, output: { success: true } }), true);
      await result;
      assert.equal(delegation.settle({ id: call.id, output: {} }), false);
      delegation.close();
    },
  },
  {
    name: 'agents: pre-cancelled Claude calls never launch a process',
    run: async (): Promise<void> => {
      const controller = new AbortController();
      controller.abort(new Error('cancelled before launch'));
      await assert.rejects(new ClaudeCodeProvider('must-not-execute').callStructured({ ...CALL, signal: controller.signal }), /cancelled before launch/u);
    },
  },
];
