import type { Diagram, Part } from '../shared/diagram';
import type { Understanding } from '../shared/understanding';

interface PublicationOptions {
  branch?: string;
  commit?: string;
  locale: string;
  paths: ReadonlyMap<string, string>;
  interpretations?: ReadonlyMap<string, Understanding>;
  repository?: { url: string; revision: string };
}

const evidence = (
  part: Part,
  diagram: Diagram,
  options: PublicationOptions,
): { path: string; interpretation: Understanding | undefined } => {
  const sourceKey = part.ref ?? '';
  const knownPath = options.paths.get(sourceKey) ?? options.paths.get(`file:${part.detail ?? ''}`);
  const path = knownPath ?? diagram.path;
  const interpretation = options.interpretations?.get(sourceKey) ?? options.interpretations?.get(`file:${path}`);
  return { path, interpretation };
};

/** Keep scanner IDs intact so inspection, source cards and branch deltas address the same entities. */
export const publication = (diagram: Diagram, options: PublicationOptions): Record<string, unknown> => {
  const ids = new Set(diagram.items.map((part) => part.id));
  if (diagram.links.some((wire) => !ids.has(wire.from) || !ids.has(wire.to))) {
    throw new Error('A relationship references an unresolved item.');
  }
  const items = diagram.items.map(({ parent, ...part }) => {
    const { path, interpretation } = evidence(part, diagram, options);
    return {
      ...part,
      interpretation,
      ...(parent !== undefined && ids.has(parent) ? { parent } : {}),
      ...(path === '' ? {} : { source: { path, line: part.line, quote: interpretation?.whatEvidence } }),
    };
  });
  return {
    version: 1,
    meta: { locale: options.locale, branch: options.branch, commit: options.commit, repository: options.repository },
    diagrams: [{ ...diagram, items }],
  };
};
