// Standalone test-only process: node:test forbids recursive run() in a test file.
// Forward genuine TestsStream envelopes without rewriting their data fields.
import { run } from 'node:test';

const stream = run({ files: [process.argv[2]], isolation: 'process', timeout: 2000 });
for await (const event of stream) {
  await new Promise((resolve, reject) => process.send(event, (error) => error ? reject(error) : resolve()));
}
process.disconnect();
