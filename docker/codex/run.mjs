// MALT's Codex launcher. It runs only inside MALT's Codex container (docker/codex/Dockerfile), which has no workspace
// mount, a read-only root filesystem and no capabilities. It reads one request line on stdin, runs one `codex exec`
// with every tool switched off (no shell, no process spawned through a shell), and prints one JSON line:
// {"output": <the answer>} or {"error": "<why it failed>"}. The extension built the request: MALT's static
// instructions, the redacted prompt (repository text only inside nonced data blocks) and a strict-mode schema.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_REQUEST_BYTES = 4_000_000;
const MAX_ANSWER_BYTES = 900_000;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/u;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

const print = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

/** The first line on stdin. The extension keeps stdin open until the container exits, so a newline ends the request. */
const readRequest = async () => await new Promise((resolve, reject) => {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    text += chunk;
    const end = text.indexOf('\n');
    if (end >= 0) {
      process.stdin.pause();
      resolve(text.slice(0, end));
    } else if (text.length > MAX_REQUEST_BYTES) {
      reject(new Error('The request is too large'));
    }
  });
  process.stdin.on('end', () => { reject(new Error('The request ended before its newline')); });
  process.stdin.on('error', reject);
});

const parseRequest = (line) => {
  const request = JSON.parse(line);
  const valid = typeof request === 'object' && request !== null
    && typeof request.instructions === 'string' && typeof request.prompt === 'string'
    && typeof request.schema === 'object' && request.schema !== null
    && (request.model === undefined || MODEL.test(request.model))
    && (request.effort === undefined || EFFORTS.has(request.effort));
  if (!valid) {
    throw new Error('The request is malformed');
  }
  return request;
};

/**
 * Codex flags. Every tool is off: no shell or command execution, images, apps, agents or web search; and no
 * built-in instructions, AGENTS.md, user config, history or saved session. The sandbox stays read-only besides.
 */
const codexArgs = (files, request) => [
  'exec',
  '--skip-git-repo-check',
  '--ephemeral',
  '--ignore-user-config',
  '--sandbox', 'read-only',
  '-c', 'features.shell_tool=false',
  '-c', 'features.view_image=false',
  '-c', 'features.apps=false',
  '-c', 'features.multi_agent=false',
  '-c', 'tools.web_search=false',
  '-c', 'project_doc_max_bytes=0',
  '-c', 'history.persistence="none"',
  '-c', 'personality="none"',
  '-c', `model_instructions_file="${files.instructions}"`,
  ...(request.model === undefined ? [] : ['-m', request.model]),
  ...(request.effort === undefined ? [] : ['-c', `model_reasoning_effort="${request.effort}"`]),
  '--output-schema', files.schema,
  '-o', files.answer,
  '-',
];

/** Runs Codex with the prompt on its stdin; resolves with the exit code and the tail of its output (for errors). */
const runCodex = async (args, prompt, cwd) => await new Promise((resolve, reject) => {
  const child = spawn('codex', args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  let tail = '';
  const keep = (chunk) => { tail = `${tail}${String(chunk)}`.slice(-2_000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('error', reject);
  child.on('close', (code) => { resolve({ code, tail }); });
  child.stdin.end(prompt);
});

/** Codex's last error line (it retries, repeating the same error), without the key if Codex echoed it. */
const lastError = (tail) => {
  const lines = tail.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  const error = lines.findLast((line) => line.startsWith('ERROR:')) ?? lines.at(-1) ?? 'no output';
  const key = process.env.CODEX_API_KEY;
  return (key === undefined || key === '' ? error : error.replaceAll(key, '[REDACTED]')).slice(0, 1_000);
};

const main = async () => {
  const request = parseRequest(await readRequest());
  const work = await mkdtemp(join(tmpdir(), 'malt-codex-'));
  const cwd = await mkdtemp(join(tmpdir(), 'malt-empty-'));
  const files = { instructions: join(work, 'instructions.md'), schema: join(work, 'schema.json'), answer: join(work, 'answer.json') };
  await writeFile(files.instructions, request.instructions, { mode: 0o600 });
  await writeFile(files.schema, JSON.stringify(request.schema), { mode: 0o600 });
  const { code, tail } = await runCodex(codexArgs(files, request), request.prompt, cwd);
  if (code !== 0) {
    throw new Error(`Codex failed (exit code ${String(code)}): ${lastError(tail)}`);
  }
  const answer = await readFile(files.answer, 'utf8');
  if (Buffer.byteLength(answer) > MAX_ANSWER_BYTES) {
    throw new Error('Codex\'s answer is too long');
  }
  print({ output: JSON.parse(answer) });
};

main().then(() => { process.exit(0); }, (error) => {
  print({ error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
