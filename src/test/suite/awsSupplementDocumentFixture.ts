import assert from 'node:assert/strict';
import type * as vscode from 'vscode';
import { AwsDocuments } from '../../cloud/documents';
import { queueValue } from './awsData';
import type { Coverage } from './awsData';

export const DOCUMENT_BYTES = 8 * 1024 * 1024;

export const coverageText = (text: string): Coverage => ({ services: [{ service: 'sqs', operations: [{
  operation: 'CreateQueue', status: 'partial', testKinds: ['unit'], limitations: [text],
}] }] });

export const readJson = (documents: AwsDocuments, uri: vscode.Uri): unknown => {
  const parsed: unknown = JSON.parse(documents.provideTextDocumentContent(uri));
  return parsed;
};

/** Exercise unknown callers of the public method without a cast or private access. */
export const addUnknown = (documents: AwsDocuments, kind: unknown, value: unknown): void => {
  Reflect.apply(documents.add.bind(documents), undefined, [kind, value]);
};

export const rejectionMessage = (operation: () => unknown): string => {
  let message: string | undefined;
  assert.throws(operation, (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.trim().length > 0);
    message = error.message;
    return true;
  });
  assert.ok(message !== undefined);
  return message;
};

export const fillDocuments = (documents: AwsDocuments, count = 32): vscode.Uri[] =>
  Array.from({ length: count }, (...[, index]): vscode.Uri => documents.add('resource', queueValue(`queue-${String(index)}`)));

export const withDocuments = (run: (documents: AwsDocuments, dispose: () => void) => void): void => {
  const documents = new AwsDocuments();
  let disposed = false;
  const dispose = (): void => {
    if (!disposed) { disposed = true; documents.dispose(); }
  };
  try {
    run(documents, dispose);
  } finally {
    dispose();
  }
};
