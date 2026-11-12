import type { FileArea } from '../../shared/aws/files';

export class Persistence {
  private readonly area: FileArea;
  private readonly snapshot: () => unknown;
  private readonly coverage: unknown;
  private revision = 0;
  private saved = -1;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> = Promise.resolve();
  public constructor(area: FileArea, snapshot: () => unknown, coverage: unknown) {
    this.area = area; this.snapshot = snapshot; this.coverage = coverage;
  }
  public dirty(): void { this.revision += 1; this.schedule(); }
  private schedule(): void {
    if (this.stopped || this.timer !== undefined) { return; }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => { process.stderr.write('AWS state flush failed; dirty state retained for retry.\n'); })
        .finally(() => { if (this.saved !== this.revision) { this.schedule(); } });
    }, 500);
    this.timer.unref();
  }
  public async flush(): Promise<void> {
    const write = async (): Promise<void> => {
      const revision = this.revision;
      if (this.saved !== revision) {
        await this.area.write('state.json', this.snapshot());
      }
      await this.area.write('coverage.json', this.coverage);
      this.saved = revision;
    };
    const result = this.pending.then(write, write);
    this.pending = result;
    await result;
  }
  public async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
  }
}
