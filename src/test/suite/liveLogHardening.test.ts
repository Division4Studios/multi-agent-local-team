/**
 * Regression tests for the PR #7 review findings on the live reviewer log:
 * secret redaction, UTF-8 decoding across chunk boundaries, bounded page state, and stream lifecycle.
 * Secret-shaped fixtures are assembled at runtime so no credential-like literal is ever committed.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import * as vscode from 'vscode';
import { StreamRedactor, redactSecrets } from '../../reviewer/redact';
import { ConversationLog } from '../../reviewer/conversations';
import { createLineSplitter } from '../../shared/lineSplitter';
import { eventReader } from '../../reviewer/providers/claudeCode';
import { ReviewerClient, conversationReader } from '../../review/reviewerClient';
import { demuxDockerLogs } from '../../backend/dockerApi';
import { createReviewerServer, shutdownReviewerServer } from '../../reviewer/server';
import { ReviewService } from '../../reviewer/service';
import { LiveLogConnection } from '../../views/conversationPanel';
import type { LiveLogMessage, LiveLogSource } from '../../views/conversationPanel';
import type { ConversationEvent, ConversationText } from '../../shared/conversation';
import { REVIEW_TYPE_INFO } from '../../shared/reviewProfiles';
import { waitFor } from './testUtils';
import type { TestCase } from './harness';

const fake = (...parts: readonly string[]): string => parts.join('');
const GITHUB = fake('gh', 'p_', 'A1b2C3d4'.repeat(5));
const ANTHROPIC = fake('sk-', 'ant-', 'api03-', 'x9Y8z7W6'.repeat(4));
const AWS = fake('AK', 'IA', 'Q3EXAMPLEKEY7890');
const JWT = fake('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');
const PEM = fake('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEow', 'IBAAKCAQEA7x\n-----END ', 'RSA PRIVATE KEY-----');
const PASSWORD = fake('hunter2', '-correct-horse');

/** Joins a call's streamed text events. */
const streamedText = (events: readonly ConversationEvent[]): string =>
  events.filter((event): event is ConversationText => event.kind === 'text').map((event) => event.text).join('');

export const tests: readonly TestCase[] = [
  {
    name: 'redaction: known credential formats and keyed literals are masked; ordinary code is untouched',
    run: (): void => {
      const text = [
        `GITHUB_TOKEN=${GITHUB}`,
        `const client = new Anthropic({ apiKey: "${ANTHROPIC}" });`,
        `aws_access_key_id = ${AWS}`,
        `Authorization: Bearer ${JWT}`,
        `postgres://admin:${PASSWORD}@db.internal:5432/app`,
        `password: '${PASSWORD}'`,
        PEM,
      ].join('\n');
      const redacted = redactSecrets(text);
      for (const secret of [GITHUB, ANTHROPIC, AWS, JWT, PASSWORD, 'MIIEowIBAAKCAQEA7x']) {
        assert.ok(!redacted.includes(secret), `leaked: ${secret.slice(0, 6)}…`);
      }
      assert.ok(redacted.includes('GITHUB_TOKEN=') && redacted.includes('apiKey: "[REDACTED]"'), 'keys stay readable');
      const code = 'function login(token: string, password: Password): void {\n  const apiKey = readKey();\n}';
      assert.equal(redactSecrets(code), code, 'type annotations and calls are not secrets');
    },
  },
  {
    name: 'redaction: a secret split across streamed chunks is still masked; text still streams word by word',
    run: (): void => {
      const stream = new StreamRedactor();
      const half = Math.floor(GITHUB.length / 2);
      const released = [
        stream.push('The token is '),
        stream.push(GITHUB.slice(0, half)),
        stream.push(`${GITHUB.slice(half)} and the "password": `),
        stream.push(`"${PASSWORD}" `),
        stream.push(PEM.slice(0, 40)),
        stream.push(`${PEM.slice(40)} done`),
      ];
      assert.equal(released[0], 'The token is ', 'complete words are released immediately');
      assert.equal(released[1], '', 'a possible secret in progress is held');
      const all = released.join('') + stream.flush();
      assert.ok(!all.includes(GITHUB.slice(0, half)) && !all.includes(GITHUB.slice(half)), 'no half of the token leaks');
      assert.ok(!all.includes(PASSWORD), 'a key and its value arriving separately are redacted together');
      assert.ok(!all.includes('MIIEow'), 'a private-key block split across chunks is masked');
      assert.ok(all.endsWith(' done'));
    },
  },
  {
    name: 'redaction: the live log never stores or sends a secret in prompts, streamed text or errors',
    run: (): void => {
      const log = new ConversationLog();
      const events: ConversationEvent[] = [];
      log.subscribe((event) => events.push(event));
      const call = log.begin('Overview · .env:1', REVIEW_TYPE_INFO.overview.defaults, `File: .env\n+ANTHROPIC_API_KEY=${ANTHROPIC}\n`);
      call.text(`{"why": "adds ${GITHUB.slice(0, 10)}`);
      call.text(`${GITHUB.slice(10)} to config"}`);
      call.end(new Error(`claude failed with key ${AWS}`));
      const wire = JSON.stringify([...events, ...log.recent()]);
      for (const secret of [ANTHROPIC, GITHUB, AWS]) {
        assert.ok(!wire.includes(secret), `secret reached the log: ${secret.slice(0, 6)}…`);
      }
      assert.ok(streamedText(events).includes('[REDACTED]'));
    },
  },
  {
    name: 'utf-8: characters split across chunks decode intact in every stream reader',
    run: (): void => {
      const bytes = Buffer.from('{"note":"café – naïve ✓"}\n', 'utf8');
      const split = bytes.indexOf(0xc3) + 1;
      const lines: string[] = [];
      const splitter = createLineSplitter((line) => lines.push(line));
      splitter.push(bytes.subarray(0, split));
      splitter.push(bytes.subarray(split));
      splitter.end();
      assert.deepEqual(lines, ['{"note":"café – naïve ✓"}']);

      const claude: unknown[] = [];
      const reader = eventReader((event) => claude.push(event));
      const result = Buffer.from('{"type":"result","structured_output":{"note":"café"}}', 'utf8');
      const cut = result.indexOf(0xc3) + 1;
      reader.push(result.subarray(0, cut));
      reader.push(result.subarray(cut));
      reader.end();
      assert.deepEqual(claude, [{ type: 'result', structured_output: { note: 'café' } }], 'a final line without a newline is still read');

      const event = Buffer.from(`${JSON.stringify({ kind: 'text', callId: 'a1b2c3d4e5f60718', at: 1, text: 'naïve' })}\n`, 'utf8');
      const received: ConversationEvent[] = [];
      const client = conversationReader((parsed) => received.push(parsed), () => undefined);
      const at = event.indexOf(0xc3) + 1;
      client.push(event.subarray(0, at));
      client.push(event.subarray(at));
      assert.equal(received[0]?.kind === 'text' ? received[0].text : '', 'naïve');
    },
  },
  {
    name: 'utf-8: Docker log frames that split a character decode intact; CRLF and overflow are handled',
    run: (): void => {
      const text = Buffer.from('ready – ✓\n', 'utf8');
      const at = text.indexOf(0xe2) + 1;
      const frame = (payload: Buffer): Buffer => {
        const header = Buffer.alloc(8);
        header.writeUInt8(1, 0);
        header.writeUInt32BE(payload.length, 4);
        return Buffer.concat([header, payload]);
      };
      assert.equal(demuxDockerLogs(Buffer.concat([frame(text.subarray(0, at)), frame(text.subarray(at))])), 'ready – ✓\n');
      const lines: string[] = [];
      let overflowed = false;
      const splitter = createLineSplitter((line) => lines.push(line), { maxLineChars: 10, onOverflow: () => { overflowed = true; } });
      splitter.push(Buffer.from('a\r\nb\n'));
      splitter.push(Buffer.from('x'.repeat(20)));
      assert.deepEqual(lines, ['a', 'b']);
      assert.ok(overflowed, 'an endless line is cut off, not buffered forever');
    },
  },
  {
    name: 'lifecycle: shutting down the reviewer closes open live-log streams',
    run: async (): Promise<void> => {
      const service = new ReviewService(
        { workspaceRoot: '.', profiles: { overview: REVIEW_TYPE_INFO.overview.defaults, check: REVIEW_TYPE_INFO.check.defaults, consolidation: REVIEW_TYPE_INFO.consolidation.defaults, standards: REVIEW_TYPE_INFO.standards.defaults } },
        { name: 'fake', callStructured: async (): Promise<unknown> => await Promise.resolve({}) },
      );
      const server: Server = createReviewerServer(service, 'token-0123456789');
      await new Promise<void>((resolvePromise) => {
        server.listen(0, '127.0.0.1', resolvePromise);
      });
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      let closed = false;
      new ReviewerClient({ port, token: 'token-0123456789' }).streamConversations(() => undefined, () => {
        closed = true;
      });
      await new Promise<void>((resolvePromise) => {
        setTimeout(resolvePromise, 200);
      });
      assert.equal(closed, false, 'the stream is open');
      shutdownReviewerServer(server);
      await waitFor(() => closed, 'the stream closes on shutdown', 3_000);
    },
  },
  {
    name: 'lifecycle: the log disconnects when the reviewer stops and attaches to the restarted one',
    run: async (): Promise<void> => {
      const statuses = new vscode.EventEmitter<{ readonly state: string }>();
      const streams: { readonly name: string; stopped: boolean; readonly drop: () => void; readonly deliver: (event: ConversationEvent) => void }[] = [];
      const makeClient = (name: string): NonNullable<LiveLogSource['client']> => ({
        streamConversations: (onEvent, onClose): (() => void) => {
          const stream = { name, stopped: false, drop: (): void => { onClose(); }, deliver: onEvent };
          streams.push(stream);
          return () => {
            stream.stopped = true;
            onClose();
          };
        },
      });
      const source: { client: LiveLogSource['client']; readonly status: { readonly state: string }; readonly onDidChangeStatus: vscode.Event<{ readonly state: string }> } = {
        client: makeClient('first'),
        status: { state: 'running' },
        onDidChangeStatus: statuses.event,
      };
      const messages: LiveLogMessage[] = [];
      const connection = new LiveLogConnection(source, (message) => messages.push(message), 20);
      try {
        assert.deepEqual(streams.map((stream) => stream.name), ['first']);
        source.client = undefined;
        statuses.fire({ state: 'stopped' });
        assert.equal(streams[0]?.stopped, true, 'stopping the reviewer ends the stream');
        assert.equal(connection.connected, false);
        await new Promise<void>((resolvePromise) => {
          setTimeout(resolvePromise, 60);
        });
        assert.equal(streams.length, 1, 'a deliberate disconnect never reconnects');
        source.client = makeClient('restarted');
        statuses.fire({ state: 'running' });
        assert.deepEqual(streams.map((stream) => stream.name), ['first', 'restarted'], 'attaches to the new instance');
        streams[1]?.drop();
        await waitFor(() => streams.length === 3, 'an unexpected drop reconnects to the running reviewer', 1_000);
      } finally {
        connection.dispose();
        statuses.dispose();
      }
    },
  },
  {
    name: 'live log page: evicted cards release their state, so a long session stays bounded',
    run: async (): Promise<void> => {
      const page = await loadLiveLogPage();
      try {
        for (let index = 0; index < 200; index += 1) {
          page.post({ type: 'event', event: { kind: 'start', callId: index.toString(16).padStart(16, '0'), at: 1, label: `call ${String(index)}`, model: 'haiku', effort: 'low', prompt: 'p' } });
        }
        assert.equal(page.list.children.length, 150, 'at most 150 cards');
        const evicted = page.detached();
        assert.ok(evicted.length >= 50, 'old cards were removed from the page');
        const before = evicted.map((element) => element.writes);
        page.tick();
        assert.deepEqual(evicted.map((element) => element.writes), before, 'the timer never touches evicted calls');
        page.post({ type: 'event', event: { kind: 'text', callId: '0'.repeat(16), at: 2, text: 'late' } });
        assert.equal(page.list.children.length, 150, 'events for evicted calls are ignored');
      } finally {
        page.cleanup();
      }
    },
  },
];

/** A minimal DOM for running media/liveLog.js outside a browser. */
class FakeElement {
  public readonly children: FakeElement[] = [];
  public parentNode: FakeElement | null = null;
  public className = '';
  public writes = 0;
  private text = '';

  public get textContent(): string {
    return this.text;
  }

  public set textContent(value: string) {
    this.writes += 1;
    this.text = value;
    if (value === '') {
      this.children.length = 0;
    }
  }

  public get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  public appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  public removeChild(child: FakeElement): FakeElement {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }

  public descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

interface FakePage {
  readonly list: FakeElement;
  readonly post: (data: unknown) => void;
  readonly tick: () => void;
  /** Elements the script created that are no longer on the page. */
  readonly detached: () => FakeElement[];
  /** Removes the fake browser globals again. */
  readonly cleanup: () => void;
}

const loadLiveLogPage = async (): Promise<FakePage> => {
  const byId = new Map(['calls', 'status', 'usage'].map((id) => [id, new FakeElement()]));
  const created: FakeElement[] = [];
  let onMessage: ((message: { readonly data: unknown }) => void) | undefined;
  let tick: (() => void) | undefined;
  const originalSetInterval = globalThis.setInterval;
  Reflect.set(globalThis, 'document', {
    getElementById: (id: string) => byId.get(id),
    createElement: () => {
      const element = new FakeElement();
      created.push(element);
      return element;
    },
    body: { scrollHeight: 0 },
  });
  Reflect.set(globalThis, 'window', {
    addEventListener: (type: string, listener: (message: { readonly data: unknown }) => void) => {
      if (type === 'message') {
        onMessage = listener;
      }
    },
    innerHeight: 0,
    scrollY: 0,
    scrollTo: () => undefined,
  });
  Reflect.set(globalThis, 'setInterval', (callback: () => void) => {
    tick = callback;
    return 0;
  });
  try {
    const script = join(__dirname, '..', '..', '..', 'media', 'liveLog.js');
    await import(`${pathToFileURL(script).href}?run=${String(Date.now())}`);
  } finally {
    Reflect.set(globalThis, 'setInterval', originalSetInterval);
  }
  const list = byId.get('calls');
  if (list === undefined || onMessage === undefined || tick === undefined) {
    assert.fail('the page script did not initialise');
  }
  const listener = onMessage;
  const timer = tick;
  const attached = (): Set<FakeElement> => new Set([list, ...list.descendants()]);
  return {
    list,
    post: (data: unknown): void => {
      listener({ data });
    },
    tick: timer,
    detached: (): FakeElement[] => {
      const live = attached();
      return created.filter((element) => !live.has(element));
    },
    cleanup: (): void => {
      Reflect.deleteProperty(globalThis, 'document');
      Reflect.deleteProperty(globalThis, 'window');
    },
  };
};
