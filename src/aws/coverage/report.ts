import { join } from 'node:path';
import { readOrdinary } from '../../shared/aws/files';
import { parseStrictJson } from '../../shared/aws/json';
import type { AwsCoverage, TestKind } from '../../shared/aws/types';
import type { ServiceBackend } from '../services/types';
import { parseEvidence, runtimeDigest } from './evidence';
import type { EvidenceCase } from './evidence';

const loadEvidence = async (root: string): Promise<readonly EvidenceCase[]> => {
  try {
    const bytes = await readOrdinary(join(root, 'aws', 'test-evidence.json'));
    if (bytes === undefined) { return []; }
    return parseEvidence(parseStrictJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), await runtimeDigest(root)) ?? [];
  } catch { return []; }
};
export const coverageReport = async (backends: readonly ServiceBackend[], root: string): Promise<AwsCoverage> => {
  const evidence = await loadEvidence(root);
  return { services: backends.map(backend => ({ service: backend.service,
    operations: [...backend.operations].map(([operation, support]) => {
      const kinds = new Set<TestKind>();
      for (const entry of evidence) {
        if (entry.operations.includes(`${backend.service}.${operation}`)) { kinds.add(entry.kind); }
      }
      return { operation, ...support, testKinds: [...kinds].sort((a, b) => a < b ? -1 : Number(a > b)) };
    }),
  })) };
};
