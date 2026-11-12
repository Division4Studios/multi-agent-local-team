import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import type { AwsDocuments } from '../../cloud/documents';
import type { TestCase } from './harness';
import { DOCUMENT_BYTES, coverageText, fillDocuments, rejectionMessage, withDocuments } from './awsSupplementDocumentFixture';

interface DisplayedDocument {
  readonly uri: vscode.Uri;
  readonly text: string;
  readonly bytes: number;
}

const assertBudget = (documents: AwsDocuments, inserted: readonly DisplayedDocument[]): number => {
  let bytes = 0;
  let retained = 0;
  const retainedUris = new Set<string>();
  for (const entry of [...inserted].reverse()) {
    if (bytes + entry.bytes > DOCUMENT_BYTES || retained === 32) { break; }
    bytes += entry.bytes;
    retained += 1;
    retainedUris.add(entry.uri.toString());
  }
  for (const entry of inserted) {
    if (retainedUris.has(entry.uri.toString())) {
      assert.equal(documents.provideTextDocumentContent(entry.uri), entry.text);
    } else {
      assert.throws(() => documents.provideTextDocumentContent(entry.uri));
    }
  }
  return retained;
};

export const tests: readonly TestCase[] = [
  {
    name: 'AWS supplement document budget: FIFO eviction follows observed displayed UTF-8 bytes, including multibyte text',
    run: (): void => {
      withDocuments(documents => {
        const inserted: DisplayedDocument[] = [];
        let retained = 0;
        for (let index = 0; index < 7; index += 1) {
          const value = coverageText(`fixture-${String(index)}:${'界'.repeat(500_000)}`);
          const uri = documents.add('coverage', value);
          const text = documents.provideTextDocumentContent(uri);
          const parsed: unknown = JSON.parse(text);
          assert.deepEqual(parsed, value);
          const bytes = Buffer.byteLength(text, 'utf8');
          assert.ok(bytes < DOCUMENT_BYTES, 'each valid fixture must fit independently');
          inserted.push({ uri, text, bytes });
          retained = assertBudget(documents, inserted);
        }
        assert.ok(retained > 0 && retained < inserted.length, 'the test must cross the byte budget before the document-count limit');
      });
    },
  },
  {
    name: 'AWS supplement document budget: a single oversized valid DTO cannot evict or modify existing entries',
    run: (): void => {
      withDocuments(documents => {
        const uris = fillDocuments(documents);
        const before = uris.map(uri => documents.provideTextDocumentContent(uri));
        const huge = coverageText(`PRIVATE-OVERSIZE-MARKER:${'x'.repeat(DOCUMENT_BYTES)}`);
        const message = rejectionMessage(() => documents.add('coverage', huge));
        assert.ok(!message.includes('PRIVATE-OVERSIZE-MARKER'));
        assert.deepEqual(uris.map(uri => documents.provideTextDocumentContent(uri)), before);
      });
    },
  },
];
