// Runs only inside the compiler container via npm run test:compiler-sandbox.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

for (const directory of ['/workspace/src', '/workspace/out', '/workspace/node_modules', '/']) {
  const path = `${directory}/malt-probe-${randomUUID()}`;
  try {
    assert.throws(() => writeFileSync(path, 'must be denied'), error =>
      error.code === 'EROFS' || error.code === 'EACCES');
  } finally {
    if (existsSync(path)) {
      rmSync(path);
    }
  }
}
assert.equal(existsSync('/var/run/docker.sock'), false);
assert.equal(existsSync('/workspace/.git'), false);
assert.equal(existsSync('/workspace/.malt'), false);
assert.equal(process.env.MALT_COMPILER_PROBE_SECRET, undefined);
assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal));
const status = readFileSync('/proc/self/status', 'utf8');
assert.match(status, /^CapEff:\s+0+$/mu);
assert.match(status, /^NoNewPrivs:\s+1$/mu);
console.log('Compiler isolation verified: read-only inputs/root, no external network, no capabilities or host credentials.');
