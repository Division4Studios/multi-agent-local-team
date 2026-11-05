/** A small, deliberate text format; repository text never becomes arbitrary Markdown or HTML. */
export interface FindingSection { readonly title: string; readonly lines: readonly string[] }

export const findingSections = (detail: string): FindingSection[] => {
  const sections: { title: string; lines: string[] }[] = [];
  let section: { title: string; lines: string[] } = { title: 'What we found', lines: [] };
  for (const line of detail.split(/\r?\n/u).filter((value) => value.trim() !== '')) {
    const heading = /^(?:#{1,3}\s*)?(Observed|Evidence|What we found|Why it matters|Decision|Next step):?\s*$/iu.exec(line.trim());
    if (heading !== null) {
      if (section.lines.length > 0) { sections.push(section); }
      section = { title: heading[1] ?? 'Evidence', lines: [] };
      continue;
    }
    const sentences = line.replace(/^\s*[-*]\s+/u, '').split(/(?<=[.!?])\s+(?=[A-Z`])/u);
    for (const sentence of sentences) {
      if (/^(?:Decide|Choose|Agree|Document)\b/u.test(sentence) && section.lines.length > 0) {
        sections.push(section);
        section = { title: 'Decision', lines: [] };
      }
      section.lines.push(sentence);
    }
  }
  if (section.lines.length > 0) { sections.push(section); }
  return sections;
};
