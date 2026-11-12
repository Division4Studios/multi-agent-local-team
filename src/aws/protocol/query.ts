import type { ModelMember, ModelShape, ServiceModel } from '../models/model';
import { invalid } from './errors';
import { flattened, required, shape, wireName } from './models';
import { primitive } from './primitives';
import { text } from './values';

export const parseForm = (form: string): Map<string, string> => {
  const entries = new Map<string, string>();
  if (form === '') { return entries; }
  for (const pair of form.split('&')) {
    const separator = pair.indexOf('=');
    try {
      const name = decodeURIComponent((separator < 0 ? pair : pair.slice(0, separator)).replaceAll('+', ' '));
      const value = decodeURIComponent((separator < 0 ? '' : pair.slice(separator + 1)).replaceAll('+', ' '));
      if (name === '' || entries.has(name)) { throw invalid('Duplicate or empty Query parameter'); }
      entries.set(name, value);
    } catch { throw invalid('Malformed or duplicate Query parameter'); }
  }
  return entries;
};
interface Binding { readonly member: ModelMember; readonly prefix: string; readonly depth: number }
export class QueryDecoder {
  private readonly model: ServiceModel;
  private readonly values: ReadonlyMap<string, string>;
  private readonly consumed = new Set<string>();
  public constructor(model: ServiceModel, values: ReadonlyMap<string, string>) { this.model = model; this.values = values; }
  private exists(prefix: string): boolean {
    return [...this.values.keys()].some(key => key === prefix || key.startsWith(`${prefix}.`));
  }
  private indices(prefix: string): readonly string[] {
    const indices = new Set<string>();
    for (const key of this.values.keys()) {
      if (!key.startsWith(`${prefix}.`)) { continue; }
      const index = key.slice(prefix.length + 1).split('.')[0] ?? '';
      if (!/^[1-9][0-9]*$/u.test(index) || !Number.isSafeInteger(Number(index))) { throw invalid('Invalid Query list index'); }
      indices.add(index);
    }
    return [...indices].sort((a, b) => Number(a) - Number(b));
  }
  private structure(definition: Extract<ModelShape, { type: 'structure' | 'union' | 'enum' | 'intEnum' }>, prefix: string, depth: number): unknown {
    const entries = new Map<string, unknown>();
    const aliases = new Set<string>();
    for (const [key, member] of Object.entries(definition.members)) {
      const path = prefix === '' ? wireName(member, key) : `${prefix}.${wireName(member, key)}`;
      if (aliases.has(path)) { continue; }
      aliases.add(path);
      if (!this.exists(path)) {
        if (required(member)) { throw invalid(`Missing required member ${key}`); }
        continue;
      }
      entries.set(key, this.read({ member, prefix: path, depth: depth + 1 }));
    }
    return Object.fromEntries(entries);
  }
  private map(definition: Extract<ModelShape, { type: 'map' }>, binding: Binding): unknown {
    const prefix = flattened(binding.member.traits) ? binding.prefix : `${binding.prefix}.entry`;
    const entries = new Map<string, unknown>();
    for (const index of this.indices(prefix)) {
      const base = `${prefix}.${index}`;
      const key = text(this.read({ member: definition.key, prefix: `${base}.${wireName(definition.key, 'key')}`, depth: binding.depth + 1 }));
      if (entries.has(key)) { throw invalid('Duplicate Query map key'); }
      const value = this.read({ member: definition.value, prefix: `${base}.${wireName(definition.value, 'value')}`, depth: binding.depth + 1 });
      entries.set(key, value);
    }
    return Object.fromEntries(entries);
  }
  private read(binding: Binding): unknown {
    if (binding.depth > 64) { throw invalid('Query nesting exceeds limit'); }
    const definition = shape(this.model, binding.member.target);
    if (definition.type === 'structure') { return this.structure(definition, binding.prefix, binding.depth); }
    if (definition.type === 'map') { return this.map(definition, binding); }
    if (definition.type === 'list') {
      const prefix = flattened(binding.member.traits) ? binding.prefix : `${binding.prefix}.member`;
      return this.indices(prefix).map(index => this.read({ member: definition.member, prefix: `${prefix}.${index}`, depth: binding.depth + 1 }));
    }
    this.consumed.add(binding.prefix);
    return primitive(definition, this.values.get(binding.prefix), true);
  }
  public decode(target: string): unknown {
    const result = this.read({ member: { target, traits: {} }, prefix: '', depth: 0 });
    if ([...this.values.keys()].some(key => !this.consumed.has(key))) { throw invalid('Unknown or unsupported Query binding'); }
    return result;
  }
}
