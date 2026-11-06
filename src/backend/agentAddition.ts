/**
 * Adding a reviewer agent at runtime: make room for it (Docker raises the container's limits), then add it. Additions
 * run one at a time, and each sizes from the reviewer's current count, so two quick Add clicks size the container for
 * both agents instead of both sizing it for the same one.
 */
export interface AgentAdditionSteps {
  /** The reviewer's current agent count, read fresh (the monitor's snapshot can be a second old). */
  readonly count: () => Promise<number>;
  readonly resize: (agents: number) => Promise<void>;
  readonly add: () => Promise<void>;
}

/**
 * Returns `add`: each call waits for the previous one to finish (or fail), then calls `begin` for its steps, so the
 * steps bind to the reviewer that is running when the addition really starts.
 */
export const serializedAgentAddition = (): ((begin: () => AgentAdditionSteps) => Promise<void>) => {
  let previous: Promise<void> = Promise.resolve();
  return async (begin) => {
    const current = previous.then(async () => {
      const steps = begin();
      await steps.resize((await steps.count()) + 1);
      await steps.add();
    });
    previous = current.catch(() => undefined);
    await current;
  };
};
