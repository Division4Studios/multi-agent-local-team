import { jsonValue, literal } from './aws-model-values.mts';
import { validateModel } from './aws-model-validation.mts';

const HEADER = '// Generated Smithy model data; do not edit. See THIRD_PARTY.md and models/aws/sources.json.\n'
  + '// AWS source models: Apache-2.0, models/aws/LICENSE and models/aws/NOTICE.\n';
const SHARD_SIZE = 100;

interface DataModule { readonly name: string; readonly filename: string }
const moduleImport = ({ name, filename }: DataModule): string => `import { ${name} } from './${filename}';`;

/** Bound the catalog too: very large ASTs get static, hierarchical index pages. */
const catalog = (modules: readonly DataModule[], files: Map<string, string>, level = 0): DataModule => {
  const groups: DataModule[] = [];
  for (let offset = 0; offset < modules.length; offset += SHARD_SIZE) {
    const suffix = `${String(level)}-${String(offset / SHARD_SIZE).padStart(4, '0')}`;
    const group = { name: `catalog${String(level)}Group${String(offset / SHARD_SIZE)}`, filename: `catalog-${suffix}` };
    const children = modules.slice(offset, offset + SHARD_SIZE);
    const names = children.map(child => child.name).join(', ');
    const tables = level === 0 ? names : '';
    const catalogs = level === 0 ? '' : names;
    files.set(`${group.filename}.ts`, `${HEADER}import type { ShapeCatalog } from '../model';\n${children.map(moduleImport).join('\n')}\n\n`
      + `export const ${group.name}: ShapeCatalog = { tables: [${tables}], children: [${catalogs}] };\n`);
    groups.push(group);
  }
  const first = groups[0];
  if (first === undefined) {
    throw new Error('Smithy model catalog cannot be empty');
  }
  return groups.length === 1 ? first : catalog(groups, files, level + 1);
};

/** Deterministic static data only. Filenames never incorporate a source-controlled identifier. */
export const generateModelFiles = (input: unknown, signingName: string): ReadonlyMap<string, string> => {
  const model = validateModel(input, signingName);
  const entries = [...model.shapes];
  const files = new Map<string, string>();
  const modules: DataModule[] = [];
  for (let offset = 0; offset < entries.length; offset += SHARD_SIZE) {
    const suffix = String(offset / SHARD_SIZE).padStart(4, '0');
    const name = `shapes${suffix}`;
    const filename = `shapes-${suffix}`;
    const lines = entries.slice(offset, offset + SHARD_SIZE).map(([id, shape]) =>
      `  ${JSON.stringify(id)}: ${literal(jsonValue(shape, id))},`);
    files.set(`${filename}.ts`, `${HEADER}import type { ShapeTable } from '../model';\n\nexport const ${name}: ShapeTable = {\n${lines.join('\n')}\n};\n`);
    modules.push({ name, filename });
  }
  const root = catalog(modules, files);
  const metadata = [
    `  smithy: ${literal(model.smithy)},`, `  serviceId: ${literal(model.serviceId)},`,
    `  signingName: ${literal(signingName)},`, `  service: ${literal(jsonValue(model.service, model.serviceId))},`,
    `  shapes: ${root.name},`,
  ];
  files.set('index.ts', `${HEADER}import type { ServiceModel } from '../model';\n${moduleImport(root)}\n\nexport const model: ServiceModel = {\n${metadata.join('\n')}\n};\n`);
  return files;
};
