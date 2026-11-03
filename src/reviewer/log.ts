/** Line-oriented logging to stdout; the extension streams it into the "MALT Reviewer" output channel. */
export const log = (message: string): void => {
  process.stdout.write(`[malt-reviewer ${new Date().toISOString()}] ${message}\n`);
};

export const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));
