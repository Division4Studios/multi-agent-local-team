/**
 * The page for one gap investigation: the verdict in plain English first, then what the code actually does, the
 * evidence (quoted code, verified against the files), the case that it is not a gap, and what to do. Pure builder;
 * `detailPanel` escapes and renders it.
 */
import type { GapInvestigation } from '../shared/investigation';
import { VERDICT_LABELS } from '../shared/investigation';
import type { Finding } from '../shared/protocol';
import type { ListItem, ListPage } from '../views/detailPanel';

const investigatedOn = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'investigated' : `investigated ${date.toLocaleString()}`;
};

const evidenceItem = (evidence: GapInvestigation['evidence'][number]): ListItem => ({
  title: evidence.symbol === '' ? evidence.file : `${evidence.symbol} · ${evidence.file}`,
  body: [evidence.observation],
  tags: [],
  code: evidence.quote,
});

const section = (heading: string, text: string): ListPage['groups'][number] => ({ heading, items: [{ title: heading, body: [text], tags: [] }] });

export const investigationPage = (gap: Finding, investigation: GapInvestigation): ListPage => {
  const verdict = VERDICT_LABELS[investigation.verdict];
  const unsupported = investigation.verdict !== 'not-a-gap' && investigation.evidence.length === 0;
  return {
    title: gap.title,
    meta: [`${verdict} · ${investigation.confidence} confidence`, investigatedOn(investigation.investigatedAt), `${String(investigation.filesRead.length)} file(s) read`],
    empty: '',
    groups: [
      {
        heading: 'In plain English',
        items: [{
          title: `${verdict} (${investigation.confidence} confidence)`,
          body: [
            investigation.plainSummary,
            ...(unsupported ? ['MALT could not verify any of the quoted evidence against the files, so this verdict is marked low confidence.'] : []),
          ],
          tags: [],
        }],
      },
      section('What the code actually does', investigation.whatTheCodeDoes),
      {
        heading: 'Evidence from the code',
        items: investigation.evidence.length === 0
          ? [{ title: 'No verified quotes', body: ['None of the quotes the reviewer gave could be found verbatim in the files, so they were discarded.'], tags: [] }]
          : investigation.evidence.map(evidenceItem),
      },
      section('Why it might not be a gap', investigation.counterpoints),
      section('Why it matters', investigation.whyItMatters),
      section('What to do', investigation.recommendation),
      { heading: 'What was read', items: [{ title: 'Files the reviewer saw', body: investigation.filesRead.length === 0 ? ['None'] : investigation.filesRead, tags: [] }] },
      { heading: 'The original gap', items: [{ title: gap.title, body: [gap.note, gap.detail], tags: gap.files }] },
    ],
  };
};
