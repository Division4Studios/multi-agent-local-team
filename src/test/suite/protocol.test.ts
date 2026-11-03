import assert from 'node:assert/strict';
import { parseHunkReview, parseReviewRequest, parseStandardsDocument } from '../../shared/protocol';
import type { TestCase } from './harness';

const CHECK = { ruleId: 'reuse-existing', title: 'Reuses existing code', status: 'fail', note: 'Duplicates retry()', detail: 'Lines 3-9 copy retry().' };
const RULE = { id: 'reuse-existing', title: 'Reuses existing code', check: 'Reuses?', category: 'Architecture', source: 'MALT baseline' };
const OVERVIEW = {
  summary: 'Adds retry without backoff',
  purpose: 'Uploads survive flaky networks.',
  technical: 'Retries the request.',
  design: 'Should reuse the existing retry helper.',
  applicable: ['reuse-existing'],
};
const REVIEW = { overview: OVERVIEW, rules: [RULE], checks: [CHECK] };

export const tests: readonly TestCase[] = [
  {
    name: 'parseHunkReview: accepts a valid review',
    run: (): void => {
      assert.deepEqual(parseHunkReview(REVIEW), REVIEW);
    },
  },
  {
    name: 'parseHunkReview: rejects unknown statuses and missing fields',
    run: (): void => {
      assert.equal(parseHunkReview({ ...REVIEW, overview: { ...OVERVIEW, applicable: [1] } }), undefined);
      assert.equal(parseHunkReview({ ...REVIEW, checks: [{ ...CHECK, status: 'maybe' }] }), undefined);
      assert.equal(parseHunkReview({ ...REVIEW, checks: [{ ...CHECK, detail: undefined }] }), undefined);
      assert.equal(parseHunkReview({ ...REVIEW, overview: { ...OVERVIEW, purpose: 42 } }), undefined);
      assert.equal(parseHunkReview('not an object'), undefined);
    },
  },
  {
    name: 'parseReviewRequest: requires a sane line range',
    run: (): void => {
      const valid = { filePath: 'src/a.ts', startLine: 3, endLine: 5, patch: '@@' };
      assert.deepEqual(parseReviewRequest(valid), valid);
      assert.equal(parseReviewRequest({ ...valid, endLine: 2 }), undefined);
      assert.equal(parseReviewRequest({ ...valid, startLine: -1 }), undefined);
      assert.equal(parseReviewRequest({ ...valid, startLine: 1.5 }), undefined);
    },
  },
  {
    name: 'parseStandardsDocument: validates version and every rule',
    run: (): void => {
      const rule = { id: 'r', title: 'T', check: 'C?', category: 'style', source: 'CLAUDE.md' };
      const document = { version: 1, generatedAt: '2026-11-03T00:00:00.000Z', rules: [rule] };
      assert.deepEqual(parseStandardsDocument(document), document);
      assert.equal(parseStandardsDocument({ ...document, version: 2 }), undefined);
      assert.equal(parseStandardsDocument({ ...document, rules: [{ ...rule, id: 1 }] }), undefined);
    },
  },
];
