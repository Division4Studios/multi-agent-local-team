import * as vscode from 'vscode';
import type { Finding } from '../shared/protocol';
import { findingSections } from '../shared/findingText';

export type FindingLinks = ReadonlyMap<string, vscode.Uri>;

/** Resolve only real workspace paths, or unambiguous suffixes of the finding's known files. */
export const findingLinks = async (
  finding: Finding, resolve: (path: string) => Promise<vscode.Uri | undefined>,
): Promise<FindingLinks> => {
  const paths = new Set(finding.files);
  for (const file of finding.files) {
    const segments = file.split('/');
    for (let i = 1; i < segments.length; i++) { paths.add(segments.slice(0, i).join('/')); }
  }
  const references = [...finding.detail.matchAll(/`([^`\r\n]+)`/gu)].map((match) => match[1] ?? '');
  const links = new Map<string, vscode.Uri>();
  await Promise.all([...new Set([...finding.files, ...references])].slice(0, 100).map(async (reference) => {
    const matches = [...paths].filter((path) => path === reference || path.endsWith(`/${reference}`));
    const path = paths.has(reference) ? reference : matches.length === 1 ? matches[0] : reference;
    if (path === undefined) { return; }
    const uri = await resolve(path);
    if (uri !== undefined) { links.set(reference, uri); }
  }));
  return links;
};

const escaped = (text: string): string => new vscode.MarkdownString().appendText(text).value;

export const appendReference = (markdown: vscode.MarkdownString, label: string, uri: vscode.Uri): void => {
  markdown.appendMarkdown(`[${escaped(label)}](<${uri.toString().replace(/>/gu, '%3E')}>)`);
};

const inline = (markdown: vscode.MarkdownString, text: string, links: FindingLinks): void => {
  for (const [index, part] of text.split('`').entries()) {
    const uri = links.get(part);
    if (index % 2 === 0) { markdown.appendText(part); }
    else if (uri !== undefined) { appendReference(markdown, part, uri); }
    else { markdown.appendMarkdown(`\`${part.replace(/[\r\n]/gu, ' ')}\``); }
  }
};

export const findingMarkdown = (finding: Finding, links: FindingLinks = new Map()): vscode.MarkdownString => {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = false;
  markdown.appendText(finding.note);
  for (const section of findingSections(finding.detail)) {
    markdown.appendMarkdown(`\n\n**${escaped(section.title)}**\n\n`);
    for (const line of section.lines) {
      markdown.appendMarkdown('- ');
      inline(markdown, line, links);
      markdown.appendMarkdown('\n');
    }
  }
  if (links.size > 0) {
    markdown.appendMarkdown('\n\n**References**\n\n');
    for (const file of finding.files) {
      const uri = links.get(file);
      if (uri !== undefined) {
        markdown.appendMarkdown('- ');
        appendReference(markdown, file, uri);
        markdown.appendMarkdown('\n');
      }
    }
  }
  return markdown;
};
