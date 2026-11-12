import { createRequire } from 'node:module';

interface EvidenceRuntime { readonly runtimeDigest: (root: string) => Promise<string> }
interface EvidenceArea {
  remove(name: string): Promise<void>;
  write(name: string, value: unknown): Promise<void>;
}
interface FilesRuntime {
  readonly fileArea: (root: string, create?: boolean) => Promise<EvidenceArea>;
  readonly realDirectory: (root: string) => Promise<{ readonly path: string }>;
}
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;
const evidenceModule = (value: unknown): value is EvidenceRuntime => record(value) && typeof value['runtimeDigest'] === 'function';
const filesModule = (value: unknown): value is FilesRuntime =>
  record(value) && typeof value['fileArea'] === 'function' && typeof value['realDirectory'] === 'function';
const require = createRequire(import.meta.url);
const evidence: unknown = require('../out/aws/coverage/evidence.js');
const files: unknown = require('../out/shared/aws/files.js');
if (!evidenceModule(evidence) || !filesModule(files)) { throw new Error('Compile AWS evidence helpers before testing'); }
export const runtimeDigest = evidence.runtimeDigest;
export const fileArea = files.fileArea;
export const realDirectory = files.realDirectory;
