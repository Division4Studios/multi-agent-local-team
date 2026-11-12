import type { AwsAdminApi } from './adminClient';

export const pause = async (ms: number): Promise<void> => { await new Promise<void>(resolve => { setTimeout(resolve, ms); }); };
export const runtimeReady = async (client: AwsAdminApi, exited: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !exited()) {
    try { await client.health(); return; }
    catch { await pause(100); }
  }
  throw new Error('Local AWS did not become healthy.');
};
