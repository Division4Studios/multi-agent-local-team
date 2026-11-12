/** Bounded JSON grammar with duplicate decoded-key detection at every object. */
class JsonReader {
  private position = 0;
  private readonly source: string;
  public constructor(source: string) { this.source = source; }

  private whitespace(): void {
    while (/[\x20\t\n\r]/u.test(this.source[this.position] ?? 'x')) { this.position += 1; }
  }
  private take(token: string): boolean {
    this.whitespace();
    if (!this.source.startsWith(token, this.position)) { return false; }
    this.position += token.length;
    return true;
  }
  private string(): string {
    const start = this.position;
    this.position += 1;
    while (this.position < this.source.length) {
      const character = this.source[this.position];
      this.position += 1;
      if (character === '\\') { this.position += 1; }
      else if (character === '"') {
        const value: unknown = JSON.parse(this.source.slice(start, this.position));
        if (typeof value === 'string') { return value; }
        break;
      }
    }
    throw new Error('Invalid JSON string');
  }
  private object(depth: number): Readonly<Record<string, unknown>> {
    const entries = new Map<string, unknown>();
    if (this.take('}')) { return {}; }
    do {
      this.whitespace();
      if (this.source[this.position] !== '"') { throw new Error('Invalid JSON object'); }
      const key = this.string();
      if (entries.has(key) || !this.take(':')) { throw new Error('Duplicate or invalid JSON member'); }
      entries.set(key, this.value(depth));
      if (this.take('}')) { return Object.fromEntries(entries); }
    } while (this.take(','));
    throw new Error('Invalid JSON object');
  }
  private array(depth: number): readonly unknown[] {
    const values: unknown[] = [];
    if (this.take(']')) { return values; }
    do {
      values.push(this.value(depth));
      if (this.take(']')) { return values; }
    } while (this.take(','));
    throw new Error('Invalid JSON array');
  }
  private scalar(): unknown {
    for (const [token, value] of [['true', true], ['false', false], ['null', null]]) {
      if (typeof token === 'string' && this.take(token)) { return value; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.source.slice(this.position));
    if (match === null || !Number.isFinite(Number(match[0]))) { throw new Error('Invalid JSON value'); }
    this.position += match[0].length;
    return Number(match[0]);
  }
  private value(depth: number): unknown {
    if (depth > 64) { throw new Error('JSON nesting exceeds limit'); }
    this.whitespace();
    if (this.source[this.position] === '"') { return this.string(); }
    if (this.take('{')) { return this.object(depth + 1); }
    if (this.take('[')) { return this.array(depth + 1); }
    return this.scalar();
  }
  public read(): unknown {
    const result = this.value(0);
    this.whitespace();
    if (this.position !== this.source.length) { throw new Error('Invalid JSON trailing content'); }
    return result;
  }
}
export const parseStrictJson = (text: string): unknown => new JsonReader(text).read();
