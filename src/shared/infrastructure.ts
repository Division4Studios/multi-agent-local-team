import { newDiagram } from './diagram';
import type { Diagram, Part } from './diagram';
export const infraPath = (p: string): boolean =>
  /(?:\.tf|(?:^|\/)(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml|(?:^|\/)Dockerfile(?:\.[\w-]+)?)$/iu.test(p);
interface Section {
  group: string;
  service: string;
  depends: boolean;
}
const resource = (line: string, index: number): Part | undefined => {
  const tf = /^\s*(?:resource|data)\s+"([\w-]+)"\s+"([\w-]+)"\s*\{/u.exec(line);
  if (tf !== null) {
    const id = `${String(tf[1])}.${String(tf[2])}`;
    return { id, label: id, group: tf[1] ?? 'Resource', line: index + 1 };
  }
  const stage = /^FROM\s+([\w./:@-]+)(?:\s+AS\s+([\w-]+))?/iu.exec(line);
  if (stage === null) {
    return undefined;
  }
  const id = stage[2] ?? `stage-${String(index + 1)}`;
  return { id, label: id, group: 'Container stage', line: index + 1 };
};
const dependencies = (line: string, s: Section): string[] => {
  if (/^ {4}\S/u.test(line)) {
    s.depends = /^ {4}depends_on:/u.test(line);
    return s.depends
      ? (/\[([^\]]+)\]/u.exec(line)?.[1] ?? '')
          .split(',')
          .map((i) => i.trim())
          .filter(Boolean)
      : [];
  }
  const entry = /^ {6}(?:-\s+)?([\w.-]+)(?::|$)/u.exec(line)?.[1];
  return s.depends && entry !== undefined ? [entry] : [];
};
const composeLine = (d: Diagram, s: Section, line: string, index: number): void => {
  if (/^[\w-]+:/u.test(line)) {
    s.group = line.split(':')[0] ?? '';
    s.service = '';
    s.depends = false;
  }
  if (s.group !== 'services') {
    return;
  }
  const service = /^ {2}([\w.-]+):\s*$/u.exec(line)?.[1];
  if (service !== undefined) {
    d.items.push({ id: service, label: service, group: 'Compose service', line: index + 1 });
    s.service = service;
    s.depends = false;
    return;
  }
  for (const to of dependencies(line, s)) {
    d.links.push({ from: s.service, to, label: 'depends_on' });
  }
};
/** Only declaration and dependency names enter the model. Configuration values stay out. */
export const infrastructure = (path: string, source: string): Diagram[] => {
  const d = newDiagram(path, 'architecture', path),
    section: Section = { group: '', service: '', depends: false };
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const part = resource(line, index);
    if (part !== undefined) {
      d.items.push(part);
    } else {
      composeLine(d, section, line, index);
    }
  }
  return d.items.length > 0 ? [d] : [];
};
