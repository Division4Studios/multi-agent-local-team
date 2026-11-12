import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { AwsDocuments } from '../../cloud/documents';
import type { TestCase } from './harness';
import { coverageValue, queueValue, tracesValue } from './awsData';
import { addUnknown, fillDocuments, readJson, rejectionMessage, withDocuments } from './awsSupplementDocumentFixture';
import { assertOldestEvicted, assertResidentBytes, snapshotResidents } from './awsSupplementOracles';

export const tests: readonly TestCase[] = [
  {
    name: 'AWS supplement documents: every add owns a fresh URI even for identical values and across instances',
    run: (): void => {
      withDocuments(documents => {
        const other = new AwsDocuments();
        try {
          const first = documents.add('resource', queueValue());
          const second = documents.add('resource', queueValue());
          const foreign = other.add('resource', queueValue());
          assert.equal(new Set([first.toString(), second.toString(), foreign.toString()]).size, 3);
          assert.equal(first.scheme, 'malt-aws');
          assert.deepEqual(readJson(documents, vscode.Uri.parse(first.toString())), queueValue());
          assert.throws(() => documents.provideTextDocumentContent(foreign));
          assert.throws(() => other.provideTextDocumentContent(first));
          assert.deepEqual(readJson(documents, second), queueValue());
        } finally {
          other.dispose();
        }
      });
    },
  },
  {
    name: 'AWS supplement documents: the thirty-third insertion evicts the oldest, and reads never refresh insertion order',
    run: (): void => {
      withDocuments(documents => {
        const uris = fillDocuments(documents);
        for (const uri of uris) { assert.doesNotThrow(() => documents.provideTextDocumentContent(uri)); }
        const oldest = uris[0];
        assert.ok(oldest !== undefined);
        readJson(documents, oldest);
        readJson(documents, oldest);
        const next = documents.add('traces', tracesValue());
        assert.throws(() => documents.provideTextDocumentContent(oldest));
        for (const uri of uris.slice(1)) { assert.doesNotThrow(() => documents.provideTextDocumentContent(uri)); }
        assert.deepEqual(readJson(documents, next), tracesValue());
      });
    },
  },
  {
    name: 'AWS supplement documents: invalid kind, mismatched DTO and secret-bearing extras preserve the full resident cache',
    run: (): void => {
      withDocuments(documents => {
        const uris = fillDocuments(documents);
        const read = documents.provideTextDocumentContent.bind(documents);
        const before = snapshotResidents(uris, read);
        const invalid: readonly (readonly [unknown, unknown])[] = [
          ['unsupported-kind', queueValue()], ['resource', coverageValue()], ['coverage', tracesValue()], ['traces', queueValue()],
          ['resource', { ...queueValue(), token: 'PRIVATE-DOCUMENT-MARKER' }], ['resource', {}], ['coverage', null],
        ];
        for (const [kind, value] of invalid) {
          const message = rejectionMessage(() => { addUnknown(documents, kind, value); });
          assert.ok(!message.includes('PRIVATE-DOCUMENT-MARKER'));
          assertResidentBytes(before, read);
        }
        const next = documents.add('traces', tracesValue());
        assertOldestEvicted(before, read);
        assert.deepEqual(readJson(documents, next), tracesValue());
      });
    },
  },
  {
    name: 'AWS supplement documents: unknown and foreign URIs yield static errors independent of caller-controlled URI text',
    run: (): void => {
      withDocuments(documents => {
        const owned = documents.add('resource', queueValue());
        const invalid = [
          owned.with({ scheme: 'file' }), owned.with({ authority: 'FOREIGN-OWNER' }),
          owned.with({ path: '/UNKNOWN-PRIVATE-PATH-A' }), owned.with({ path: '/UNKNOWN-PRIVATE-PATH-B' }),
        ];
        const messages = invalid.map(uri => rejectionMessage(() => documents.provideTextDocumentContent(uri)));
        for (const message of messages) { assert.doesNotMatch(message, /FOREIGN-OWNER|UNKNOWN-PRIVATE-PATH/u); }
        assert.equal(messages[2], messages[3], 'unknown-resource errors must not interpolate the requested path');
        assert.deepEqual(readJson(documents, owned), queueValue());
      });
    },
  },
  {
    name: 'AWS supplement documents: disposal invalidates every owned URI and refuses later additions',
    run: (): void => {
      withDocuments((documents, dispose) => {
        const uris = [documents.add('resource', queueValue()), documents.add('coverage', coverageValue()), documents.add('traces', tracesValue())];
        dispose();
        const messages = uris.map(uri => rejectionMessage(() => documents.provideTextDocumentContent(uri)));
        assert.equal(new Set(messages).size, 1);
        assert.throws(() => documents.add('resource', queueValue()));
        assert.throws(() => documents.add('coverage', coverageValue()));
        assert.throws(() => documents.add('traces', tracesValue()));
      });
    },
  },
];
