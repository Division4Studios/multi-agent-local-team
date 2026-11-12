import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createEvidenceCollector } from './aws-evidence-collector.mts';
import { fileArea, realDirectory, runtimeDigest } from './aws-evidence-runtime.mts';

export const writeTestEvidence = async (events: AsyncIterable<unknown>, runtimeRoot: string): Promise<boolean> => {
  const root = (await realDirectory(runtimeRoot)).path;
  const area = await fileArea(join(root, 'aws'));
  await area.remove('test-evidence.json');
  const digest = await runtimeDigest(root);
  const collector = createEvidenceCollector();
  for await (const event of events) { collector.accept(event); }
  const cases = collector.result();
  if (cases === undefined || await runtimeDigest(root) !== digest) { return false; }
  await area.write('test-evidence.json', { formatVersion: 1, runtimeDigest: digest, cases });
  return true;
};
export default async function* reporter(events: AsyncIterable<unknown>): AsyncGenerator<string> {
  const success = await writeTestEvidence(events, fileURLToPath(new URL('../out/', import.meta.url)));
  if (!success) { process.exitCode = 1; }
  yield success ? 'AWS executed evidence published.\n' : 'AWS evidence invalidated: test run did not complete successfully.\n';
}
