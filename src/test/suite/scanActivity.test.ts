/** Scan progress: what each running stage is doing, so a long answer can be told from a stalled call. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activitySnapshot, trackScanActivity } from '../../reviewer/scanActivity';
import { ARCHITECTURE_SCHEMA } from '../../reviewer/prompts';
import { ReviewService } from '../../reviewer/service';
import type { StructuredCall } from '../../reviewer/providers/provider';
import { describeStage, scanNotification, STALL_MS } from '../../standards/scanNotification';
import { parseScanProgress } from '../../shared/scanProgress';
import type { ScanProgress } from '../../shared/scanProgress';
import { profilesFromEnv } from '../../shared/reviewProfiles';
import type { TestCase } from './harness';

const activity = (elapsedMs: number, outputChars: number, quietMs: number, heard: boolean): { elapsedMs: number; outputChars: number; quietMs: number; heard: boolean } =>
  ({ elapsedMs, outputChars, quietMs, heard });

export const tests: readonly TestCase[] = [
  {
    name: 'scan progress: each running stage says whether it is waiting, thinking, writing or possibly stalled',
    run: (): void => {
      assert.equal(describeStage('Architecture', undefined), 'Architecture: starting');
      assert.equal(describeStage('Architecture', activity(45_000, 0, 45_000, false)), 'Architecture: waiting for the model (45s)');
      assert.equal(describeStage('Architecture', activity(80_000, 0, 2_000, true)), 'Architecture: model is thinking (1m 20s)');
      assert.equal(describeStage('Architecture', activity(185_000, 12_400, 1_000, true)), 'Architecture: writing, 12.4k characters so far (3m 05s)');
      assert.equal(describeStage('Gaps', activity(400_000, 900, STALL_MS - 1, true)), 'Gaps: writing, 900 characters so far (6m 40s)', 'just under the threshold is not a stall');
      assert.match(describeStage('Gaps', activity(400_000, 900, STALL_MS, true)), /^Gaps: no response for 2m 00s, may be stalled/u);
      assert.match(describeStage('Standards', activity(130_000, 0, 130_000, false)), /no response for 2m 10s/u, 'silence from the start is a stall too');
    },
  },
  {
    name: 'scan progress: the notification leads with what is running and keeps counting finished stages',
    run: (): void => {
      const reports: { message?: string; increment?: number }[] = [];
      const report = scanNotification({ report: (value) => { reports.push(value); } });
      report({ stage: 'sources', state: 'complete' });
      report({ stage: 'standards', state: 'running', activity: activity(65_000, 3_000, 500, true) });
      report({ stage: 'architecture', state: 'running', activity: activity(65_000, 0, 65_000, false) });
      assert.equal(reports.at(-1)?.message, 'Standards: writing, 3.0k characters so far (1m 05s) · Architecture: waiting for the model (1m 05s) · 1 of 4 stages done');
      assert.equal(reports.reduce((sum, value) => sum + (value.increment ?? 0), 0), 25, 'activity updates never move the percentage');
    },
  },
  {
    name: 'scan progress: activity is display only, so a malformed one is dropped and never fails the scan',
    run: (): void => {
      const valid = activity(1_000, 10, 0, true);
      assert.deepEqual(parseScanProgress({ stage: 'gaps', state: 'running', activity: valid }), { stage: 'gaps', state: 'running', activity: valid });
      assert.deepEqual(parseScanProgress({ stage: 'gaps', state: 'running', activity: { ...valid, quietMs: -1 } }), { stage: 'gaps', state: 'running' });
      assert.deepEqual(parseScanProgress({ stage: 'gaps', state: 'running', activity: { ...valid, heard: 'yes' } }), { stage: 'gaps', state: 'running' });
      assert.deepEqual(parseScanProgress({ stage: 'gaps', state: 'complete', activity: valid }), { stage: 'gaps', state: 'complete' }, 'only a running stage has activity');
      assert.equal(parseScanProgress({ stage: 'invented', state: 'running', activity: valid }), undefined);
    },
  },
  {
    name: 'scan progress: the reviewer counts answer text and treats any model event (thinking included) as activity',
    run: (): void => {
      let now = 1_000;
      const reported: ScanProgress[] = [];
      const tracker = trackScanActivity((event) => { reported.push(event); }, () => now);
      const watch = tracker.begin('architecture');
      now = 31_000;
      tracker.tick();
      watch.onActivity();
      now = 35_000;
      watch.onText('{"modules":[');
      now = 40_000;
      tracker.tick();
      tracker.end('architecture');
      tracker.tick();
      assert.deepEqual(reported.map((event) => event.activity), [activity(30_000, 0, 30_000, false), activity(39_000, 12, 5_000, true)],
        'silent at first, then heard; text is counted; a finished stage stops reporting');
      assert.deepEqual(activitySnapshot({ started: 5_000, outputChars: 0 }, 1_000), activity(0, 0, 0, false), 'a clock step back never goes negative');
      tracker.stop();
    },
  },
  {
    name: 'scan progress: every scan stage passes its model call the activity callbacks',
    run: async (): Promise<void> => {
      const root = await mkdtemp(join(tmpdir(), 'malt-scan-activity-'));
      await writeFile(join(root, 'CLAUDE.md'), '# Rules\nUse camelCase.\n');
      await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
      const calls: StructuredCall[] = [];
      const service = new ReviewService({ workspaceRoot: root, profiles: profilesFromEnv({}) }, {
        name: 'fake', callStructured: async (call): Promise<unknown> => {
          calls.push(call);
          call.onActivity?.();
          call.onText?.('{}');
          const modules = { modules: [{ path: 'a.ts', purpose: 'A', exports: ['a'], understanding: { what: 'w', whatEvidence: '', why: 'y', whyEvidence: '', question: 'q' } }] };
          return await Promise.resolve(call.schema === ARCHITECTURE_SCHEMA ? modules : { rules: [], gaps: [] });
        },
      });
      const events: ScanProgress[] = [];
      await service.scanStandards((event) => { events.push(event); });
      assert.equal(calls.length, 3, 'standards, architecture and gaps');
      assert.ok(calls.every((call) => typeof call.onActivity === 'function' && typeof call.onText === 'function'));
      assert.deepEqual(events.filter((event) => event.state !== 'running').map((event) => `${event.stage} ${event.state}`),
        ['sources complete', 'standards complete', 'architecture complete', 'gaps complete']);
    },
  },
];
