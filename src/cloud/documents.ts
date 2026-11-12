import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { parseAwsCoverage, parseAwsQueueResource, parseAwsTraces } from '../shared/aws/parsers';

export type AwsDocumentKind = 'resource' | 'coverage' | 'traces';
interface DocumentEntry { readonly text: string; readonly bytes: number }
const LIMIT = 8 * 1024 * 1024;
const serialize = (kind: AwsDocumentKind, value: unknown): string => {
  let parsed: unknown;
  switch (kind) {
    case 'resource': parsed = parseAwsQueueResource(value); break;
    case 'coverage': parsed = parseAwsCoverage(value); break;
    case 'traces': parsed = parseAwsTraces(value); break;
  }
  if (parsed === undefined) { throw new Error('Invalid Local AWS document.'); }
  return JSON.stringify(parsed, null, 2);
};

export class AwsDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly entries = new Map<string, DocumentEntry>();
  private readonly owner = randomUUID();
  private bytes = 0;
  private disposed = false;
  public add(kind: AwsDocumentKind, value: unknown): vscode.Uri {
    this.check();
    const text = serialize(kind, value);
    const bytes = Buffer.byteLength(text);
    if (bytes > LIMIT) { throw new Error('Local AWS document exceeds the display limit.'); }
    const uri = vscode.Uri.from({ scheme: 'malt-aws', authority: this.owner, path: `/${kind}-${randomUUID()}.json` });
    while (this.entries.size >= 32 || this.bytes + bytes > LIMIT) { this.evict(); }
    this.entries.set(uri.toString(), { text, bytes });
    this.bytes += bytes;
    return uri;
  }
  public provideTextDocumentContent(uri: vscode.Uri): string {
    this.check();
    const entry = this.entries.get(uri.toString());
    if (entry === undefined) { throw new Error('Local AWS document is unavailable or expired.'); }
    return entry.text;
  }
  public dispose(): void { this.disposed = true; this.entries.clear(); this.bytes = 0; }
  private check(): void { if (this.disposed) { throw new Error('Local AWS documents are disposed.'); } }
  private evict(): void {
    const first = this.entries.entries().next().value;
    if (first !== undefined) { this.entries.delete(first[0]); this.bytes -= first[1].bytes; }
  }
}
