import assert from 'node:assert/strict';
import { createTar } from '../../backend/tar';
import { demuxDockerLogs } from '../../backend/dockerApi';
import { resolveInWorkspace } from '../../reviewer/workspace';
import type { TestCase } from './harness';

const readOctal = (buffer: Buffer, offset: number, length: number): number =>
  Number.parseInt(buffer.toString('ascii', offset, offset + length).replace(/\0.*$/su, '').trim(), 8);

const frame = (stream: number, text: string): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt8(stream, 0);
  header.writeUInt32BE(Buffer.byteLength(text), 4);
  return Buffer.concat([header, Buffer.from(text)]);
};

export const tests: readonly TestCase[] = [
  {
    name: 'createTar: writes valid ustar headers, padding and end blocks',
    run: (): void => {
      const tar = createTar([{ name: 'Dockerfile', data: Buffer.from('FROM scratch\n') }]);
      assert.equal(tar.length, 512 + 512 + 1024);
      assert.equal(tar.toString('utf8', 0, 10), 'Dockerfile');
      assert.equal(readOctal(tar, 124, 12), 13);
      assert.equal(tar.toString('ascii', 257, 262), 'ustar');
      const header = Buffer.from(tar.subarray(0, 512));
      const stored = readOctal(header, 148, 8);
      header.fill(' ', 148, 156);
      assert.equal(stored, header.reduce((sum, byte) => sum + byte, 0));
    },
  },
  {
    name: 'createTar: is deterministic and rejects long names',
    run: (): void => {
      const entries = [{ name: 'a.js', data: Buffer.from('x') }];
      assert.deepEqual(createTar(entries), createTar(entries));
      assert.throws(() => createTar([{ name: 'x'.repeat(101), data: Buffer.alloc(0) }]));
    },
  },
  {
    name: 'demuxDockerLogs: strips multiplexed stream headers',
    run: (): void => {
      assert.equal(demuxDockerLogs(Buffer.concat([frame(1, 'out\n'), frame(2, 'err\n')])), 'out\nerr\n');
    },
  },
  {
    name: 'resolveInWorkspace: confines paths to the workspace root',
    run: (): void => {
      const root = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';
      assert.ok(resolveInWorkspace(root, 'src/a.ts').startsWith(root));
      assert.throws(() => resolveInWorkspace(root, '../secrets.txt'));
      assert.throws(() => resolveInWorkspace(root, 'src/../../escape'));
      assert.throws(() => resolveInWorkspace(root, process.platform === 'win32' ? 'D:\\other' : '/etc/passwd'));
      assert.throws(() => resolveInWorkspace(root, ''));
    },
  },
];
