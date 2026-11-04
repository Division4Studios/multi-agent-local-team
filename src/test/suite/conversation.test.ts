/** The live reviewer log: event validation, the in-memory log's limits, and parsing Claude's stream events. */
import assert from 'node:assert/strict';
import { parseConversationEvent } from '../../shared/conversation';
import type { ConversationEvent, ConversationText } from '../../shared/conversation';
import { ConversationLog } from '../../reviewer/conversations';
import { streamedText } from '../../reviewer/providers/claudeCode';
import type { TestCase } from './harness';

const START = { kind: 'start', callId: 'a1b2c3d4e5f60718', at: 1, label: 'Overview · src/a.rs:21', model: 'sonnet', effort: 'low', prompt: 'p' };

const record = (log: ConversationLog): ConversationEvent[] => {
  const events: ConversationEvent[] = [];
  log.subscribe((event) => events.push(event));
  return events;
};

export const tests: readonly TestCase[] = [
  {
    name: 'conversation events: valid events parse, malformed ones are rejected',
    run: (): void => {
      assert.deepEqual(parseConversationEvent(START), START);
      assert.deepEqual(parseConversationEvent({ kind: 'text', callId: START.callId, at: 2, text: '{"a"' }), { kind: 'text', callId: START.callId, at: 2, text: '{"a"' });
      assert.deepEqual(parseConversationEvent({ kind: 'end', callId: START.callId, at: 3, ok: false, error: 'x' }), { kind: 'end', callId: START.callId, at: 3, ok: false, error: 'x' });
      assert.equal(parseConversationEvent({ ...START, callId: '../../etc' }), undefined);
      assert.equal(parseConversationEvent({ ...START, at: -1 }), undefined);
      assert.equal(parseConversationEvent({ ...START, kind: 'script' }), undefined);
      assert.equal(parseConversationEvent({ ...START, prompt: 42 }), undefined);
      assert.equal(parseConversationEvent('not an object'), undefined);
    },
  },
  {
    name: 'conversation log: start, streamed text and one end per call, in order',
    run: (): void => {
      const log = new ConversationLog();
      const events = record(log);
      const call = log.begin('Check no-secrets · src/a.rs:21', { model: 'haiku', effort: 'low' }, 'the prompt');
      call.text('{"status": ');
      call.text('');
      call.text('"pass", "note": "o');
      call.text('k"}');
      call.end();
      call.end(new Error('ignored: already ended'));
      call.text('ignored: already ended');
      assert.deepEqual(events.map((event) => event.kind), ['start', 'text', 'text', 'text', 'end'], 'released word by word, the rest on end');
      const streamed = events.filter((event): event is ConversationText => event.kind === 'text').map((event) => event.text).join('');
      assert.equal(streamed, '{"status": "pass", "note": "ok"}', 'nothing lost or duplicated');
      const start = events[0];
      const end = events.at(-1);
      assert.ok(start?.kind === 'start' && start.label.startsWith('Check no-secrets') && start.model === 'haiku' && start.effort === 'low');
      assert.ok(end?.kind === 'end' && end.ok && end.error === '');
      assert.ok(events.every((event) => event.callId === start.callId));
      assert.deepEqual(parseConversationEvent(JSON.parse(JSON.stringify(start))), start, 'events survive the wire format');
    },
  },
  {
    name: 'conversation log: failures carry the error; prompts, text and backlog are bounded',
    run: (): void => {
      const log = new ConversationLog();
      const events = record(log);
      const failed = log.begin('Gap analysis', { model: 'opus', effort: 'medium' }, 'x '.repeat(25_000));
      failed.text('y\n'.repeat(125_000));
      failed.text('more');
      failed.end(new Error('claude returned an error: overloaded'));
      const start = events[0];
      assert.ok(start?.kind === 'start' && start.prompt.length < 41_000 && start.prompt.includes('truncated'));
      const streamed = events
        .filter((event): event is ConversationText => event.kind === 'text')
        .reduce((sum, event) => sum + event.text.length, 0);
      assert.equal(streamed, 200_000, 'per-call text is capped');
      assert.deepEqual(events.at(-1), { kind: 'end', callId: start.callId, at: events.at(-1)?.at, ok: false, error: 'claude returned an error: overloaded' });
      for (let index = 0; index < 5_000; index += 1) {
        log.begin('x', { model: 'm', effort: 'low' }, 'p').end();
      }
      assert.ok(log.recent().length <= 4_000, 'backlog is bounded');
    },
  },
  {
    name: 'claude stream: structured-output and text deltas are extracted, other events ignored',
    run: (): void => {
      const delta = (value: Record<string, unknown>): unknown => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: value } });
      assert.equal(streamedText(delta({ type: 'input_json_delta', partial_json: '{"verdict": "pa' })), '{"verdict": "pa');
      assert.equal(streamedText(delta({ type: 'text_delta', text: 'hello' })), 'hello');
      assert.equal(streamedText(delta({ type: 'input_json_delta', partial_json: 42 })), undefined);
      assert.equal(streamedText({ type: 'result', structured_output: {} }), undefined);
      assert.equal(streamedText({ type: 'stream_event', event: { type: 'message_stop' } }), undefined);
      assert.equal(streamedText(undefined), undefined);
    },
  },
];
