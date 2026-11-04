/** A bounded, offline source index. Keep evidence as names and locations; never store source bodies. */
import { createHash } from 'node:crypto';
import type { Diagram } from './diagram';
import { evidenceDiagrams, evidencePath } from './evidence';
import { infraPath, infrastructure } from './infrastructure';
import { posix } from 'node:path';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export type Relation = 'imports' | 'inherits' | 'implements' | 'calls' | 'renders';
export interface SymbolFact {
  readonly name: string;
  readonly qualified: string;
  readonly parent: string;
  readonly kind: string;
  readonly line: number;
  hash: string;
}
export interface Reference {
  readonly owner: string;
  readonly name: string;
  readonly relation: Relation;
  readonly line: number;
}
export interface ImportFact {
  readonly spec: string;
  readonly local: string;
  readonly original: string;
  readonly line: number;
}
export interface FileFacts {
  readonly diagrams?: Diagram[];
  readonly members?: Map<string, string[]>;
  readonly path: string;
  readonly hash: string;
  readonly tags: string[];
  readonly symbols: SymbolFact[];
  readonly imports: ImportFact[];
  readonly refs: Reference[];
}

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
  cjs: 'JavaScript', mjs: 'JavaScript', py: 'Python', cs: 'C#', java: 'Java', kt: 'Kotlin', go: 'Go', rs: 'Rust',
  cpp: 'C++', hpp: 'C++', cc: 'C++', c: 'C', h: 'C', swift: 'Swift', vue: 'Vue', svelte: 'Svelte', rb: 'Ruby', php: 'PHP',
};
const tagsFor = (path: string): string[] => {
  const tags = [LANGUAGES[posix.extname(path).slice(1)] ?? 'source'];
  if (/\.(?:[jt]sx|vue|svelte)$/iu.test(path)) {
    tags.push('UI');
  }
  for (const [tag, pattern] of [
    ['UI', /(?:^|\/)(?:ui|components?|widgets?|views?)\//iu],
    ['test', /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./iu],
    ['data', /(?:^|\/)(?:db|data|models?|storage|repositories)\//iu],
    ['service', /(?:^|\/)(?:backend|api|services?|server)\//iu],
  ] satisfies [string, RegExp][]) {
    if (!tags.includes(tag) && pattern.test(path)) {
      tags.push(tag);
    }
  }
  return tags;
};

const DECLARATION = /\b(class|interface|record|struct|trait|enum|type|function|def|fn|func|fun)\s+([A-Za-z_$][\w$]*)/u;
const ARROW = /\b(?:const|let|var)\s+([\w$]+)(?:\s*:[^=]+)?\s*=\s*(?:async\s+)?(?:function\b|(?:<[^>]+>)?\s*\([^;]*?\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/u;
const METHOD = /^\s*(?:(?:public|private|protected|static|async|virtual|override|abstract|internal|readonly|final)\s+)*(?:[\w.<>,?[\]]+\s+)?([\w$]+)\s*\([^;]*?\)\s*(?::[^;{]+)?\s*(?:\{|=>|$)/u;
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'super', 'function', 'new', 'typeof', 'with', 'using', 'lock']);
const typeKinds = new Set(['class', 'interface', 'record', 'struct', 'trait', 'enum']);
interface Decl { readonly kind: string; readonly name: string }
const classMethod = (code: string, parent: SymbolFact | undefined): Decl | undefined => {
  const method = parent !== undefined && typeKinds.has(parent.kind) ? METHOD.exec(code)?.[1] : undefined;
  return method === undefined || CONTROL.has(method) ? undefined : { kind: 'method', name: method };
};
const declaration = (code: string, parent: SymbolFact | undefined): Decl | undefined => {
  if (/^\s*(?:import\b|export\s+type\s*\{)/u.test(code)) {
    return undefined;
  }
  const named = DECLARATION.exec(code);
  if (named?.[1] !== undefined && named[2] !== undefined) {
    return { kind: named[1], name: named[2] };
  }
  const arrow = ARROW.exec(code)?.[1];
  if (arrow !== undefined) {
    return { kind: 'function', name: arrow };
  }
  return classMethod(code, parent);
};

// Preserve line numbers and mask literal/comment contents before looking for declarations or calls.
const masked = (source: string, python: boolean): string => {
  const pattern = python
    ? /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*/gu
    : /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`/gu;
  return source.replace(pattern, (part) => part.replace(/[^\n]/gu, ' '));
};

const pythonImports = (code: string): ImportFact[] => {
  const result: ImportFact[] = [];
  for (const [index, line] of code.split('\n').entries()) {
    const match = /^\s*from\s+([.\w]+)\s+import\s+([\w, \t]+)/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      continue;
    }
    const spec = match[1];
    result.push({ spec, original: '', local: '', line: index + 1 });
    for (const binding of match[2].split(',')) {
      const [original, local] = binding.trim().split(/\s+as\s+/u);
      if (original !== undefined) {
        result.push({ spec, original, local: local ?? original, line: index + 1 });
      }
    }
  }
  return result;
};
const importsFor = (source: string, code: string): ImportFact[] => {
  const imports: ImportFact[] = [];
  // A match must also start in live code, outside comments and literals.
  for (const match of source.matchAll(/^[ \t]*(?:import|export)\s+(?:((?:(?![;'"])[\s\S]){1,1800}?)\s+from\s*)?['"]([^'"\n]+)['"]/gmu)) {
    if (!/^\s*(?:import|export)\b/u.test(code.slice(match.index, match.index + match[0].length))) {
      continue;
    }
    const spec = match[2] ?? '';
    const line = source.slice(0, match.index).split('\n').length;
    imports.push({ spec, local: '', original: '', line });
    const bindings = (match[1] ?? '').replace(/\btype\s+|[{}]/gu, '').trim().split(',');
    for (const binding of bindings) {
      const [original, alias] = binding.trim().split(/\s+as\s+/u);
      if (original !== undefined && /^[\w$]+$/u.test(original)) {
        imports.push({ spec, original, local: alias ?? original, line });
      }
    }
  }
  return imports;
};

const lastName = (base: string): string => base.trim().split('.').at(-1) ?? '';
const withoutTypeArguments = (header: string): string => {
  let depth = 0;
  let result = '';
  for (const character of header) {
    if (character === '<') {
      depth++;
    } else if (character === '>') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      result += character;
    }
  }
  return result;
};
const bases = (code: string, symbol: SymbolFact, python: boolean): Reference[] => {
  if (!typeKinds.has(symbol.kind)) {
    return [];
  }
  const header = withoutTypeArguments(code.split('{')[0] ?? '');
  const clauses = python ? /\(([^)]*)\)/gu : /(?:\b(extends|implements)\s+|:\s*)([\w.,\s]+?)(?=\s+implements\b|$)/gu;
  const refs: Reference[] = [];
  for (const match of header.matchAll(clauses)) {
    for (const base of (match[2] ?? match[1] ?? '').split(',')) {
      const name = lastName(base);
      if (/^[A-Za-z_$][\w$]*$/u.test(name)) {
        refs.push({ name, owner: symbol.qualified, relation: match[1] === 'implements' ? 'implements' : 'inherits', line: symbol.line });
      }
    }
  }
  return refs;
};

const uses = (code: string, owner: string, line: number, jsx: boolean): Reference[] => {
  const result: Reference[] = [];
  for (const match of code.matchAll(/(?<![\w$.)\]])<([A-Z][\w$]*)\b(?=\s*(?:\/?>|\{|[\w:-]+\s*=))|(?<![\w$.])(?:(?:this|self)\.)?([A-Za-z_$][\w$]*)\s*\(/gu)) {
    const name = match[1] ?? match[2] ?? '';
    if (!CONTROL.has(name) && (jsx || match[1] === undefined)) {
      result.push({ owner, name, line, relation: match[1] === undefined ? 'calls' : 'renders' });
    }
  }
  return result;
};

interface Frame { readonly symbol: SymbolFact; readonly depth: number; readonly indent: number; readonly start: number }
const indentation = (line: string): number => (/^\s*/u.exec(line)?.[0] ?? '').replaceAll('\t', '    ').length;
const delta = (line: string): number => [...line.matchAll(/\{/gu)].length - [...line.matchAll(/\}/gu)].length;
const qualifies = (parent: string, name: string): string => parent === '' ? name : `${parent}.${name}`;
const endFrame = (stack: Frame[], lines: readonly string[], end: number): void => {
  const frame = stack.pop();
  if (frame !== undefined) {
    frame.symbol.hash = digest(lines.slice(frame.start, end).join('\n').trim());
  }
};

interface Cursor {
  readonly file: FileFacts;
  readonly python: boolean;
  readonly jsx: boolean;
  readonly lines: string[];
  readonly code: string[];
  readonly stack: Frame[];
  readonly occurrences: Map<string, number>;
  depth: number;
}
const currentOwner = (cursor: Cursor): string => cursor.stack.at(-1)?.symbol.qualified ?? '';
const pushSymbol = (cursor: Cursor, decl: Decl, index: number, header: string): void => {
  const parent = currentOwner(cursor);
  const name = qualifies(parent, decl.name);
  const count = (cursor.occurrences.get(name) ?? 0) + 1;
  cursor.occurrences.set(name, count);
  const qualified = count === 1 ? name : `${name}#${String(count)}`;
  const symbol = { ...decl, qualified, parent, line: index + 1, hash: '' };
  cursor.file.symbols.push(symbol);
  cursor.file.refs.push(...bases(header, symbol, cursor.python));
  cursor.stack.push({ symbol, depth: cursor.depth, indent: indentation(header), start: index });
};

const closeIndent = (cursor: Cursor, indent: number, index: number): void => {
  while (cursor.stack.length > 0 && indent <= (cursor.stack.at(-1)?.indent ?? -1)) {
    endFrame(cursor.stack, cursor.lines, index);
  }
};
const closeBraces = (cursor: Cursor, end: number): void => {
  while (cursor.stack.length > 0 && cursor.depth <= (cursor.stack.at(-1)?.depth ?? -1)) {
    endFrame(cursor.stack, cursor.lines, end);
  }
};
/** Assemble multiline parameter lists before assigning the body to its declaration. */
const headerAt = (cursor: Cursor, index: number): { line: string; end: number } => {
  let line = cursor.code[index] ?? '';
  let end = index;
  if (/^\s*(?:(?:export|default|public|private|protected|static|async)\s+)*(?:const|function|def|[\w<>]+\s+\w+)\b/u.test(line)) {
    while (line.lastIndexOf('(') > line.lastIndexOf(')') && end + 1 < cursor.code.length && end - index < 20) {
      end++;
      line += ` ${(cursor.code[end] ?? '').trim()}`;
    }
  }
  return { line, end };
};
const collectLine = (cursor: Cursor, index: number): number => {
  const { line, end } = headerAt(cursor, index);
  if (line.trim() === '') {
    return end;
  }
  if (cursor.python) {
    closeIndent(cursor, indentation(line), index);
  }
  const decl = declaration(line, cursor.stack.at(-1)?.symbol);
  let body = line;
  if (decl !== undefined) {
    pushSymbol(cursor, decl, index, line);
    body = line.slice(line.indexOf(decl.name) + decl.name.length);
  }
  for (const ref of uses(body, currentOwner(cursor), index + 1, cursor.jsx)) {
    cursor.file.refs.push(ref);
  }
  cursor.depth += delta(line);
  const awaitingBrace = decl !== undefined && cursor.code[end + 1]?.trim() === '{';
  if (!cursor.python && !awaitingBrace) {
    closeBraces(cursor, end + 1);
  }
  return end;
};
const signatureOf=(line:string|undefined):string=>(line??'').trim().split('{')[0]?.trim()??'';
const addMember=(cursor:Cursor,index:number):void=>{
    const owner = cursor.stack.at(-1)?.symbol;
    const signature = signatureOf(cursor.code[index]);
    if (owner !== undefined && typeKinds.has(owner.kind) && /[(:=;]/u.test(signature) && signature.length <= 300) {
      const fields = cursor.file.members?.get(owner.qualified) ?? [];
      fields.push(signature); cursor.file.members?.set(owner.qualified, fields);
    }
};
export const extractFile = (path: string, source: string): FileFacts => {
  if (evidencePath(path) || infraPath(path)) {
    const diagrams = infraPath(path) ? infrastructure(path, source) : evidenceDiagrams(path, source);
    return { path, hash: digest(source.replaceAll('\r\n','\n')), tags: ['model evidence'], symbols: [], imports: [], refs: [], diagrams };
  }
  const python = path.endsWith('.py');
  const code = masked(source, python);
  const file: FileFacts = { path, hash: digest(source.replaceAll('\r\n', '\n')), tags: tagsFor(path), imports: python ? pythonImports(code) : importsFor(source, code), symbols: [], refs: [], members: new Map() };
  const cursor: Cursor = { file, python, jsx: /\.(?:jsx?|tsx|svelte|vue)$/u.test(path), code: code.split(/\r?\n/u), lines: source.split(/\r?\n/u), stack: [], occurrences: new Map(), depth: 0 };
  for (let index = 0; index < cursor.code.length; index++) {
    addMember(cursor,index);
    index = collectLine(cursor, index);
  }
  while (cursor.stack.length > 0) {
    endFrame(cursor.stack, cursor.lines, cursor.lines.length);
  }
  return file;
};
