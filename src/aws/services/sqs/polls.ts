/** Queue identity is the wakeup key, so recreation cannot inherit old waiters. */
export class Polls {
  private readonly waiters = new Map<object, Set<() => void>>();
  public async wait(queue: object, milliseconds: number): Promise<void> {
    await new Promise<void>(resolve => {
      const group = this.waiters.get(queue) ?? new Set<() => void>();
      const finish = (): void => {
        clearTimeout(timer);
        group.delete(finish);
        if (group.size === 0) { this.waiters.delete(queue); }
        resolve();
      };
      const timer = setTimeout(finish, Math.max(1, milliseconds));
      group.add(finish);
      this.waiters.set(queue, group);
    });
  }
  public wake(queue: object): void {
    for (const finish of this.waiters.get(queue) ?? []) { finish(); }
  }
  public close(): void {
    for (const queue of this.waiters.keys()) { this.wake(queue); }
  }
}
