import { join } from 'node:path';
import { generateModelFiles } from './aws-model-data.mts';
import { outputDrift, scanModelOutput, writeModelOutput } from './aws-model-files.mts';
import { verifiedSources } from './aws-model-sources.mts';
import type { ModelSource } from './aws-model-sources.mts';

interface GeneratedService {
  readonly directory: string;
  readonly files: ReadonlyMap<string, string>;
}

const generateService = (sources: ReadonlyMap<string, ModelSource>, service: string): GeneratedService => {
  const source = sources.get(`${service}.json`);
  if (source === undefined) {
    throw new Error(`Missing pinned ${service} model source`);
  }
  const parsed: unknown = JSON.parse(source.bytes.toString('utf8'));
  const provenance = `// Source: ${source.repository}@${source.revision}/${source.path}\n// SHA-256: ${source.sha256}\n`;
  const files = new Map([...generateModelFiles(parsed, service)].map(([name, text]) => [name, provenance + text]));
  return { directory: `src/aws/models/${service}`, files };
};

const main = (): void => {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: node scripts/aws-models.mts [--check]');
  }
  const check = args[0] === '--check';
  const root = join(import.meta.dirname, '..');
  const sources = verifiedSources(root);
  const services = ['sts', 'sqs'].map(service => generateService(sources, service));
  // Preflight every output tree before writing either service; links fail closed in both modes.
  const drift = services.flatMap(({ directory, files }) =>
    outputDrift(files, scanModelOutput(root, directory)).map(problem => `${directory}: ${problem}`));
  if (check && drift.length > 0) {
    throw new Error(`Generated AWS models are out of date:\n${drift.join('\n')}\nRun npm run generate:aws-models.`);
  }
  if (!check) {
    for (const { directory, files } of services) {
      writeModelOutput(root, directory, files);
    }
  }
  const count = services.reduce((total, service) => total + service.files.size, 0);
  console.log(`AWS models ${check ? 'checked' : 'generated'}: ${String(sources.size)} verified sources, ${String(count)} files (STS, SQS).`);
};

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
