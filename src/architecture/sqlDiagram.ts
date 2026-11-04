import { newDiagram } from './diagram';
import type { Diagram, Part } from './diagram';

const ident = String.raw`(?:"(?:[^"]|"")*"|${'\x60'}[^${'\x60'}]+${'\x60'}|\[[^\]]+\]|[\w$]+)`;
const qualified = `${ident}(?:\\.${ident})?`;
const plain = (name: string): string => name.replace(/["\x60[\]]/gu, '').toLowerCase();
const columns = (list: string): string[] => list.split(',').map((n) => plain(n.trim()));
interface Segment { text: string; start: number }
const mask = (source: string): string => source.replace(/--[^\n]*|\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, ' '));
/** Split on top-level commas only. Defaults and parameterized types can contain parentheses or quoted commas. */
const definitions = (sql: string, start: number): Segment[] => {
  const parts: Segment[] = [];
  let begin = start, depth = 0;
  const tokens=/'(?:''|[^'])*'|"(?:""|[^"])*"|\[[^\]]*\]|`[^`]*`|[(),]/gu;
  tokens.lastIndex=start;
  for (const token of sql.matchAll(tokens)) {
    const c=token[0], i=token.index;
    if (c==='('){depth++;continue;}
    if (depth===0&&(c===','||c===')')){
      parts.push({text:sql.slice(begin,i).trim(),start:begin});
      if(c===')'){break;}
      begin=i+1;
    } else if(c===')'){depth--;}
  }
  return parts;
};
interface Foreign { locals: string[]; table: string; remote: string }
interface Keys { primary: Set<string>; unique: string[][]; required: Set<string>; foreign: Foreign[] }
const keyList = (s: string, pattern: RegExp): string[] => {
  const list = pattern.exec(s)?.[1]; return list === undefined ? [] : columns(list);
};
const recordKeys = (keys: Keys, text: string, col: string): void => {
  const key = (pattern: RegExp): string[] => col === '' ? keyList(text, pattern) : [col];
  if (/\bPRIMARY\s+KEY\b/iu.test(text)) {
    const pk = key(/PRIMARY\s+KEY\s*\(([^)]+)\)/iu);
    pk.forEach((c) => keys.primary.add(c)); keys.unique.push(pk);
  }
  if (/\bUNIQUE\b/iu.test(text)) { keys.unique.push(key(/UNIQUE\s*\(([^)]+)\)/iu)); }
  if (/\bNOT\s+NULL\b/iu.test(text)) { keys.required.add(col); }
  const ref = new RegExp(`\\bREFERENCES\\s+(${qualified})(?:\\s*\\(([^)]+)\\))?`, 'iu').exec(text);
  if (ref?.[1] !== undefined) {
    keys.foreign.push({ locals: key(/FOREIGN\s+KEY\s*\(([^)]+)\)/iu), table: plain(ref[1]), remote: ref[2] ?? 'primary key' });
  }
};
const keysFor = (parts: Segment[]): Keys => {
  const keys: Keys = { primary: new Set(), unique: [], required: new Set(), foreign: [] };
  for (const { text } of parts) {
    const tableLevel = /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/iu.test(text);
    const column = tableLevel ? '' : plain(new RegExp(`^${ident}`, 'u').exec(text)?.[0] ?? '');
    recordKeys(keys, text, column);
  }
  return keys;
};
const addTable = (d: Diagram, name: string, line: number, parts: Segment[]): void => {
  const id=plain(name);
  if (d.items.some((item) => item.id === id)) { return; }
  const keys = keysFor(parts);
  const table: Part = { id, label: name, line, ref: `table:${  id}`, fields: parts.map((part) => part.text.replace(/\s+/gu, ' ')) };
  d.items.push(table);
  for (const fk of keys.foreign) {
    const required = fk.locals.every((c) => keys.required.has(c) || keys.primary.has(c));
    const unique = keys.unique.some((list) => list.length > 0 && list.every((c) => fk.locals.includes(c)));
    d.links.push({ from: id, to: fk.table, fromEnd: unique ? '0..1' : '0..*', toEnd: required ? '1' : '0..1',
      label: `${fk.locals.join(', ')} → ${fk.remote}`, kind: 'foreign key' });
  }
};
const addFlow = (d: Diagram, match: RegExpMatchArray): void => {
  const target = plain(match[1] ?? '');
  const select = match[2] ?? '';
  for (const read of select.matchAll(new RegExp(`\\b(?:FROM|JOIN)\\s+(${qualified})`, 'giu'))) {
    const origin = plain(read[1] ?? '');
    for (const id of [origin, target]) {
      if (!d.items.some((p) => p.id === id)) { d.items.push({ id, label: id, ref: `table:${  id}` }); }
    }
    d.links.push({ from: origin, to: target, label: 'SELECT → write', kind: 'transfer' });
  }
};
export const sqlDiagrams = (path: string, source: string): Diagram[] => {
  const sql = mask(source);
  const er = newDiagram(path, 'er', path);
  for (const m of sql.matchAll(new RegExp(`\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${qualified})\\s*\\(`, 'giu'))) {
    const name = m[1] ?? '';
    addTable(er, name, sql.slice(0, m.index).split('\n').length, definitions(sql, m.index + m[0].length));
  }
  const flow = newDiagram(path, 'dataflow', path);
  for (const m of sql.matchAll(new RegExp(`\\b(?:INSERT\\s+INTO|CREATE\\s+TABLE)\\s+(${qualified})(?:\\s*\\([^;]*?\\))?\\s+(?:AS\\s+)?(SELECT\\b[^;]*)`, 'giu'))) { addFlow(flow, m); }
  return [er, flow].filter((d) => d.items.length > 0);
};
