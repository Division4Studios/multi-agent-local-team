import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { findingSections } from '../../shared/findingText';
import { findingLinks, findingMarkdown } from '../../editor/findingMarkdown';
import { scanNotification } from '../../standards/scanNotification';
import { parseScanProgress } from '../../shared/scanProgress';
import type { TestCase } from './harness';

export const tests: TestCase[] = [
  {
    name: 'saved gap paragraphs become observations and a separate decision without losing paths',
    run: (): void => {
      const detail = '`frontend/BatchKpiGrid.tsx` uses PascalCase. `frontend/kpi-cards.tsx` uses kebab-case. Decide which convention new files use.';
      const sections = findingSections(detail);
      assert.equal(sections[0]?.lines.length, 2);
      assert.equal(sections[1]?.title, 'Decision');
      assert.equal(sections[0].lines[0], '`frontend/BatchKpiGrid.tsx` uses PascalCase.');
      assert.deepEqual(findingSections('Observed:\n- Two naming styles.\nWhy it matters:\nNew files have no rule.\nDecision:\nChoose one style.').map((section) => section.title), ['Observed', 'Why it matters', 'Decision']);
    },
  },
  {
    name: 'gap references resolve unambiguous known suffixes and cannot inject executable markdown',
    run: async (): Promise<void> => {
      const gap = { title: 'Names', note: '[run](command:evil)', detail: '`Widget.tsx` and `Button.tsx` differ. `<script>` is text.',
        files: ['src/Widget.tsx', 'a/Button.tsx', 'b/Button.tsx'], anchors: [] };
      const links = await findingLinks(gap, async (path) => await Promise.resolve(gap.files.includes(path) ? vscode.Uri.file(`/project/${path}`) : undefined));
      assert.ok(links.has('Widget.tsx'));
      assert.equal(links.has('Button.tsx'), false, 'ambiguous filename must not pick an arbitrary source');
      const markdown = findingMarkdown(gap, links);
      assert.equal(markdown.isTrusted, false);
      assert.ok(markdown.value.includes('file:///project/src/Widget.tsx'));
      assert.ok(markdown.value.includes('\\[run\\]'));
      assert.ok(!markdown.value.includes('<script>\n'));
    },
  },
  {
    name: 'scan progress counts terminal phases once and labels partial failures',
    run: (): void => {
      const reports: { message?: string; increment?: number }[] = [];
      const report = scanNotification({ report: (value) => { reports.push(value); } });
      report({ stage: 'sources', state: 'running' });
      report({ stage: 'sources', state: 'complete' });
      report({ stage: 'standards', state: 'running' });
      report({ stage: 'architecture', state: 'running' });
      report({ stage: 'standards', state: 'complete' });
      report({ stage: 'architecture', state: 'failed' });
      report({ stage: 'gaps', state: 'skipped' });
      report({ stage: 'gaps', state: 'skipped' });
      assert.equal(reports.reduce((sum, value) => sum + (value.increment ?? 0), 0), 100);
      assert.match(reports.at(-1)?.message ?? '', /Architecture failed.*Gaps skipped/u);
      assert.equal(parseScanProgress({ stage: 'invented', state: 'complete' }), undefined);
    },
  },
];
