// Synthetic ownership control only; never serves AWS requests or earns evidence.
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clearInterval, setInterval } from 'node:timers';

const mode = process.argv[2];
let pending;
let interval;
process.on('disconnect', () => {
  if (mode === 'abnormal') process.exitCode = 23;
});
process.on('message', (message) => {
  if (message.command === 'start') {
    pending = message.id;
    if (mode === 'leak' || mode === 'unsettled') {
      const marker = join(dirname(message.options.stateDirectory), 'leaked-handle.log');
      appendFileSync(marker, 'started\n');
      interval = setInterval(() => appendFileSync(marker, 'tick\n'), 20);
    }
    process.stderr.write('owned startup diagnostic\n');
  } else if (message.control === 'diagnostic-read') {
    process.send({ id: pending, error: { name: 'OwnedStartupError', code: 'OWNED_START_REJECTION',
      message: 'original startup rejection', stack: 'original owned startup stack' } });
  } else if (message.command === 'close') {
    // A cleanup implementation that calls public close could conceal this leak.
    clearInterval(interval);
    process.send({ id: message.id, result: { closed: true } });
  }
});
