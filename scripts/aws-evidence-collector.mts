import type { EvidenceCase } from '../src/shared/aws/types.ts';

export interface EvidenceCollector {
  accept(event: unknown): void;
  result(): readonly EvidenceCase[] | undefined;
}
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const testKind = (value: unknown): value is EvidenceCase['kind'] =>
  value === 'unit' || value === 'protocol' || value === 'lifecycle' || value === 'workflow' || value === 'differential';
const operationIds = (value: string | undefined): string[] | undefined => {
  const operations = value?.split(',');
  if (new Set(operations).size !== operations?.length) { return undefined; }
  return operations.every(operation => /^[a-z][a-z0-9-]*\.[A-Za-z][A-Za-z0-9]*$/u.exec(operation)?.[0] === operation)
    ? operations.sort(compare) : undefined;
};
const parseName = (name: unknown): EvidenceCase | undefined => {
  if (typeof name !== 'string') { return undefined; }
  const match = /^aws\[([^;\]]+);([a-z]+)\] .+$/u.exec(name);
  const operations = operationIds(match?.[1]);
  const kind = match?.[2];
  return testKind(kind) && operations !== undefined ? { id: name, operations, kind } : undefined;
};
const compare = (a: string, b: string): number => a < b ? -1 : Number(a > b);
const validSummary = (data: Readonly<Record<string, unknown>>): boolean => {
  const counts = data['counts'];
  if (data['success'] !== true || !record(counts)) { return false; }
  const validCounts = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo', 'suites', 'topLevel'].every(key => {
    const value = counts[key];
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
  });
  return validCounts && counts['failed'] === 0 && counts['cancelled'] === 0;
};
const genuinePass = (data: Readonly<Record<string, unknown>>): boolean => {
  const details = data['details'];
  if (!record(details) || details['type'] === 'suite') { return false; }
  return ['skip', 'todo', 'expectFailure'].every(key => data[key] === undefined || data[key] === false);
};
class Collector implements EvidenceCollector {
  private poisoned = false;
  private complete = false;
  private readonly cases = new Map<string, EvidenceCase>();
  public accept(event: unknown): void {
    if (!record(event)) { return; }
    const type = event['type'];
    const data = event['data'];
    if (type === 'test:fail' || type === 'test:interrupted') { this.poisoned = true; }
    else if (type === 'test:summary') { this.summary(data); }
    else if (type === 'test:pass' && record(data)) { this.pass(data); }
  }
  private summary(data: unknown): void {
    if (record(data) && data['file'] !== undefined) { return; }
    if (!record(data) || !validSummary(data)) { this.poisoned = true; return; }
    this.complete = true;
  }
  private pass(data: Readonly<Record<string, unknown>>): void {
    if (!genuinePass(data)) { return; }
    const entry = parseName(data['name']);
    if (entry === undefined) { return; }
    if (this.cases.has(entry.id)) { this.poisoned = true; }
    this.cases.set(entry.id, entry);
  }
  public result(): readonly EvidenceCase[] | undefined {
    return this.complete && !this.poisoned ? [...this.cases.values()].sort((a, b) => compare(a.id, b.id)) : undefined;
  }
}
export const createEvidenceCollector = (): EvidenceCollector => new Collector();
