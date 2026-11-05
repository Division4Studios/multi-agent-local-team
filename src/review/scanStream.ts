import { request } from 'node:http';
import type { ReviewerEndpoint } from './reviewerClient';
import { createLineSplitter } from '../shared/lineSplitter';
import { isRecord } from '../shared/guards';
import { parseStandardsScan } from '../shared/protocol';
import type { StandardsScan } from '../shared/protocol';
import { parseScanProgress } from '../shared/scanProgress';
import type { ScanProgress } from '../shared/scanProgress';

/** Progress and result belong to the same authenticated request; other scans cannot affect this UI. */
export const scanStream = async (endpoint: ReviewerEndpoint, report: (progress: ScanProgress) => void): Promise<StandardsScan> =>
  await new Promise((resolve, reject) => {
    let result: StandardsScan | undefined;
    let failed = false;
    const fail = (error: Error): void => { failed = true; reject(error); req.destroy(error); };
    const req = request({ host: '127.0.0.1', port: endpoint.port, path: '/standards/scan', method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, accept: 'application/x-ndjson', 'content-type': 'application/json' },
      timeout: 1_860_000,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Scan failed (HTTP ${String(response.statusCode)})`));
        return;
      }
      const reader = createLineSplitter((line) => {
        if (failed || line.trim() === '') { return; }
        try {
          const value: unknown = JSON.parse(line);
          if (!isRecord(value)) { throw new Error('Invalid scan event'); }
          if (typeof value['error'] === 'string') { throw new Error(value['error']); }
          const progress = parseScanProgress(value['progress']);
          if (progress !== undefined) { report(progress); }
          else {
            result = parseStandardsScan(value['result']);
            if (result === undefined) { throw new Error('Invalid scan result'); }
          }
        } catch (error: unknown) { fail(error instanceof Error ? error : new Error('Invalid scan event')); }
      }, { maxLineChars: 16_000_000, onOverflow: () => { fail(new Error('Scan event too large')); } });
      response.on('data', (chunk: Buffer) => { reader.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        reader.end();
        if (failed) { return; }
        if (result === undefined) { reject(new Error('Scan ended before returning results')); }
        else { resolve(result); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Standards scan timed out')));
    req.end('{}');
  });
