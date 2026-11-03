/**
 * Minimal deterministic ustar writer, used to send a build context to the Docker Engine API without dependencies.
 * Regular files only; names up to 100 bytes; mtime fixed at 0 so identical inputs produce identical archives.
 */
export interface TarEntry {
  readonly name: string;
  readonly data: Buffer;
}

const BLOCK = 512;

const writeOctal = (header: Buffer, value: number, offset: number, length: number): void => {
  header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
};

const createHeader = (entry: TarEntry): Buffer => {
  const name = Buffer.from(entry.name, 'utf8');
  if (name.length > 100) {
    throw new Error(`tar entry name too long: ${entry.name}`);
  }
  const header = Buffer.alloc(BLOCK);
  name.copy(header, 0);
  writeOctal(header, 0o644, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, entry.data.length, 124, 12);
  writeOctal(header, 0, 136, 12);
  header.fill(' ', 148, 156);
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\u000000', 257, 8, 'ascii');
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
};

export const createTar = (entries: readonly TarEntry[]): Buffer => {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(createHeader(entry), entry.data);
    const padding = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
    parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
};
