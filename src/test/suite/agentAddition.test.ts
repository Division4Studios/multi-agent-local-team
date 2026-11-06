/** Runtime agent additions (#45): sized from a fresh count, one at a time, so overlapping Add clicks never undersize. */
import assert from 'node:assert/strict';
import { serializedAgentAddition } from '../../backend/agentAddition';
import type { AgentAdditionSteps } from '../../backend/agentAddition';
import type { TestCase } from './harness';

/** A fake reviewer whose agent list grows only when `add` finishes, after a delay, like the real HTTP round trip. */
const fakeReviewer = (initial: number): { readonly steps: () => AgentAdditionSteps; readonly resizes: number[]; readonly agents: () => number } => {
  let agents = initial;
  const resizes: number[] = [];
  const later = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 10); }); };
  return {
    steps: () => ({
      count: async (): Promise<number> => { await later(); return agents; },
      resize: async (count): Promise<void> => { await later(); resizes.push(count); },
      add: async (): Promise<void> => { await later(); agents += 1; },
    }),
    resizes,
    agents: () => agents,
  };
};

export const tests: TestCase[] = [
  {
    name: 'agents: overlapping Add clicks size the container for every agent they add',
    run: async (): Promise<void> => {
      const reviewer = fakeReviewer(2);
      const add = serializedAgentAddition();
      await Promise.all([add(reviewer.steps), add(reviewer.steps), add(reviewer.steps)]);
      assert.equal(reviewer.agents(), 5);
      assert.deepEqual(reviewer.resizes, [3, 4, 5], 'each addition resized for the count it ends with');
    },
  },
  {
    name: 'agents: a failed resize adds no agent, and the next addition still runs',
    run: async (): Promise<void> => {
      const reviewer = fakeReviewer(2);
      const add = serializedAgentAddition();
      const failing = (): AgentAdditionSteps => ({ ...reviewer.steps(), resize: async (): Promise<void> => { await Promise.reject(new Error('Docker refused')); } });
      const results = await Promise.allSettled([add(failing), add(reviewer.steps)]);
      assert.deepEqual(results.map((result) => result.status), ['rejected', 'fulfilled']);
      assert.equal(reviewer.agents(), 3);
      assert.deepEqual(reviewer.resizes, [3]);
    },
  },
  {
    name: 'agents: an addition binds to the reviewer running when it starts, not when it was clicked',
    run: async (): Promise<void> => {
      const add = serializedAgentAddition();
      const started: string[] = [];
      const first = fakeReviewer(2);
      const second = fakeReviewer(2);
      let current = first;
      const begin = (): AgentAdditionSteps => { started.push(current === first ? 'first' : 'second'); return current.steps(); };
      const pending = [add(begin), add(begin)];
      current = second;
      await Promise.all(pending);
      assert.deepEqual(started, ['second', 'second'], 'steps are taken when each addition begins');
    },
  },
];
