import type { Diagram } from './diagram';

interface PublicationOptions {
  output: string;
  locale: string;
  paths: ReadonlyMap<string, string>;
  quotes?: ReadonlyMap<string, string>;
  repository?: { url: string; revision: string };
}

/** Keep scanner IDs intact so inspection, source cards and branch deltas address the same entities. */
export const publication = (diagram: Diagram, options: PublicationOptions): Record<string, unknown> => {
  const ids = new Set(diagram.items.map((part) => part.id));
  if (diagram.links.some((wire) => !ids.has(wire.from) || !ids.has(wire.to))) {
    throw new Error('A relationship references an unresolved item.');
  }
  const items = diagram.items.map(({ parent, ...part }) => {
    const path = options.paths.get(part.ref ?? '') ?? diagram.path;
    const quote = options.quotes?.get(part.ref ?? '');
    return {
      ...part,
      ...(parent !== undefined && ids.has(parent) ? { parent } : {}),
      ...(path === '' ? {} : { source: { path, line: part.line, quote } }),
    };
  });
  return {
    version: 1,
    meta: { locale: options.locale, repository: options.repository },
    diagrams: [{ ...diagram, items }],
  };
};
