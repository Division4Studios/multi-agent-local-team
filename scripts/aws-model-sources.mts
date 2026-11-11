import { createHash } from 'node:crypto';
import { checkedDirectory, readModelFile, safeRelativePath } from './aws-model-files.mts';
import { array, record, text } from './aws-model-values.mts';

export interface ModelSource {
  readonly file: string;
  readonly repository: string;
  readonly revision: string;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: Buffer;
}

const REQUIRED_FILES = ['sts.json', 'sqs.json', 'LICENSE', 'NOTICE', 'protocol-tests/LICENSE',
  'protocol-tests/NOTICE', 'protocol-tests/awsQuery-empty.smithy', 'protocol-tests/awsJson1_0-empty.smithy'];

const sourceEntry = (value: unknown, root: string): ModelSource => {
  const entry = record(value, 'source inventory entry');
  const file = safeRelativePath(text(entry['file'], 'source filename'));
  const repository = text(entry['repository'], 'source repository');
  const revision = text(entry['revision'], 'source revision');
  const path = safeRelativePath(text(entry['path'], 'source upstream path'));
  const sha256 = text(entry['sha256'], 'source sha256');
  if (revision.length !== 40 || sha256.length !== 64 || !/^[a-f0-9]{40}$/u.test(revision) || !/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new Error(`Invalid pinned revision or SHA-256 for model source ${file}`);
  }
  if (!['aws/api-models-aws', 'smithy-lang/smithy'].includes(repository)) {
    throw new Error(`Unknown model source repository: ${repository}`);
  }
  const bytes = readModelFile(root, file);
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error(`Model source integrity failure: ${file} SHA-256 differs from models/aws/sources.json`);
  }
  return { file, repository, revision, path, sha256, bytes };
};

/** Verify the entire inventory, including protocol sources and distribution notices, before generation. */
export const verifiedSources = (root: string): ReadonlyMap<string, ModelSource> => {
  const sourceRoot = checkedDirectory(root, 'models/aws');
  const parsed: unknown = JSON.parse(readModelFile(sourceRoot, 'sources.json').toString('utf8'));
  const inventory = record(parsed, 'source inventory');
  if (inventory['formatVersion'] !== 1) {
    throw new Error('Unsupported model source inventory formatVersion');
  }
  const sources = new Map<string, ModelSource>();
  for (const value of array(inventory['sources'], 'source inventory')) {
    const entry = sourceEntry(value, sourceRoot);
    if (sources.has(entry.file.toLowerCase())) {
      throw new Error(`Duplicate model source: ${entry.file}`);
    }
    sources.set(entry.file.toLowerCase(), entry);
  }
  if (sources.size !== REQUIRED_FILES.length || REQUIRED_FILES.some(file => !sources.has(file.toLowerCase()))) {
    throw new Error('Model source inventory must contain exactly the two pinned models, protocol sources and LICENSE/NOTICE files');
  }
  return sources;
};
