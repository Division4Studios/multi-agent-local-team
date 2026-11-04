/**
 * Readable pages for what the standards scan saved: all rules grouped by category, one rule, and the
 * architecture map grouped by folder. Pure builders (data in, page out); `detailPanel` escapes and renders them.
 */
import { posix } from 'node:path';
import { INFERRED_SOURCE_PREFIX } from '../shared/protocol';
import type { ArchitectureDocument, Rule, StandardsDocument } from '../shared/protocol';
import { BASELINE_RULES } from '../reviewer/prompts';
import type { ListPage } from '../views/detailPanel';
import { groupRules } from './standardsModel';

const count = (n: number, noun: string): string => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

const scanned = (generatedAt: string): string => {
  const date = new Date(generatedAt);
  return Number.isNaN(date.getTime()) ? 'scan date unknown' : `scanned ${date.toLocaleString()}`;
};

const ruleItem = (rule: Rule): ListPage['groups'][number]['items'][number] => {
  const inferred = rule.source.startsWith(INFERRED_SOURCE_PREFIX);
  return {
    title: rule.title,
    body: [rule.check],
    tags: [inferred ? 'Inferred from code' : 'Documented', `Source: ${inferred ? rule.source.slice(INFERRED_SOURCE_PREFIX.length) : rule.source}`, rule.id],
  };
};

export const standardsPage = (document: StandardsDocument | undefined): ListPage => {
  const rules = document?.rules ?? [];
  const inferred = rules.filter((rule) => rule.source.startsWith(INFERRED_SOURCE_PREFIX)).length;
  const groups = groupRules(rules).map((group) => ({ heading: group.name, items: group.rules.map(ruleItem) }));
  return {
    title: 'Project standards',
    meta: document === undefined
      ? ['Not scanned yet']
      : [count(rules.length, 'rule'), `${String(rules.length - inferred)} documented, ${String(inferred)} inferred from code`, count(groups.length, 'group'), scanned(document.generatedAt)],
    empty: 'No project standards yet. Run Scan Project Standards from the MALT Reviewer view.',
    groups: [
      ...groups,
      {
        heading: 'Always checked (MALT baseline)',
        items: BASELINE_RULES.map((rule) => ({ title: rule.title, body: [rule.check], tags: ['MALT baseline', rule.id] })),
      },
    ],
  };
};

export const rulePage = (rule: Rule): ListPage => ({
  title: rule.title,
  meta: [rule.category, rule.source.startsWith(INFERRED_SOURCE_PREFIX) ? 'Inferred from code' : 'Documented'],
  empty: '',
  groups: [{ heading: 'Rule', items: [ruleItem(rule)] }],
});

export const architecturePage = (document: ArchitectureDocument | undefined): ListPage => {
  const folders = new Map<string, ArchitectureDocument['modules'][number][]>();
  for (const module of document?.modules ?? []) {
    const folder = posix.dirname(module.path);
    folders.set(folder, [...(folders.get(folder) ?? []), module]);
  }
  return {
    title: 'Architecture map',
    meta: document === undefined ? ['Not mapped yet'] : [count(document.modules.length, 'file'), count(folders.size, 'folder'), scanned(document.generatedAt)],
    empty: 'No architecture map yet. Run Scan Project Standards from the MALT Reviewer view.',
    groups: [...folders]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([folder, modules]) => ({
        heading: folder === '.' ? '(project root)' : `${folder}/`,
        items: [...modules]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((module) => ({ title: posix.basename(module.path), body: [module.purpose], tags: module.exports.map((name) => `exports ${name}`) })),
      })),
  };
};
