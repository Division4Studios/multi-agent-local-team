// Test-only isolation: killable owner of the real public server. No implementation
// inspection, alternate server, or mock backend. Parent deadlines bound cleanup.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let running;
process.on('message', async ({ id, command, options }) => {
  try {
    let result;
    if (command === 'start') {
      const { startAwsServer } = require('../../../out/aws/server.js');
      running = await startAwsServer(options);
      result = { gatewayUrl: running.gatewayUrl, adminUrl: running.adminUrl };
    } else if (command === 'close') {
      await running?.close();
      result = { closed: true };
    } else {
      throw new Error(`Unknown test command: ${command}`);
    }
    process.send?.({ id, result });
  } catch (error) {
    process.send?.({ id, error: { message: error.message, code: error.code, stack: error.stack } });
  }
});
