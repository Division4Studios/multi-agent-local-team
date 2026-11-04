import { openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, dirname, extname, basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateModel, requireValue } from './publication/model.mjs';
import { render, hash } from './publication/html.mjs';
import { compareModels } from './publication/delta.mjs';
import { browserCheck } from './publication/browser.mjs';

const fileOf = (p) => {
  const bytes = readFileSync(p);
  return { bytes, model: validateModel(JSON.parse(bytes.toString('utf8'))), sha256: hash(bytes) };
};
const canonical = (p) => join(realpathSync(dirname(resolve(p))), basename(p));
function safeTarget(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  requireValue(!stat || (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1), 'Unsafe output: ' + path);
}
function atomic(path, bytes, check = () => {}) {
  safeTarget(path);
  const stage = join(dirname(path), '.malt-' + randomUUID() + '.tmp');
  try {
    writeFileSync(stage, bytes, { flag: 'wx', mode: 0o600 });
    check(readFileSync(stage));
    safeTarget(path);
    renameSync(stage, path);
  } finally {
    if (lstatSync(stage, { throwIfNoEntry: false })) unlinkSync(stage);
  }
}
function same(bytes, expected) {
  requireValue(hash(bytes) === hash(expected), 'Delivered file differs from the checked rendering');
}
function pathsFor(target, inputs) {
  requireValue(extname(target).toLowerCase() === '.html', 'Destination must have the .html extension');
  const output = canonical(target),
    base = output.slice(0, -5);
  const paths = { output, receipt: base + '.finalize.json', delta: base + '.delta.json', lock: output + '.malt-lock' };
  const fold = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const sources = inputs.map((p) => fold(realpathSync(p)));
  for (const p of Object.values(paths)) {
    requireValue(!sources.includes(fold(p)), 'Source and output paths must differ');
    safeTarget(p);
  }
  return paths;
}
const json = (data) => JSON.stringify(data, null, 2) + '\n';
function options(args) {
  const positional = [];
  let chrome,
    browser = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--browser-check') browser = true;
    else if (args[i] === '--browser') {
      chrome = args[++i];
      requireValue(!!chrome, 'Missing browser executable');
    } else {
      requireValue(!args[i].startsWith('--'), 'Unknown option ' + args[i]);
      positional.push(args[i]);
    }
  }
  return { positional, chrome, browser };
}
function prepare(cmd, files) {
  const first = fileOf(files[0]);
  if (cmd === 'compare') {
    const second = fileOf(files[1]);
    const compared = compareModels(first.model, second.model);
    const sources = [first.sha256, second.sha256];
    return { model: validateModel(compared.model), digest: hash(json(sources)), sources, delta: compared.delta };
  }
  if (cmd === 'patch') {
    const replacement = readFileSync(files[2]),
      panel = JSON.parse(replacement);
    requireValue(first.model.answer && panel.id === files[1], 'Replacement must preserve the selected panel ID');
    const i = first.model.answer.panels.findIndex((p) => p.id === panel.id);
    requireValue(i !== -1, 'Unknown panel');
    first.model.answer.panels[i] = panel;
    const sources = [first.sha256, hash(replacement)];
    return { model: validateModel(first.model), digest: hash(json(sources)), sources };
  }
  return { model: first.model, digest: first.sha256, sources: [first.sha256] };
}
export async function command(args, verifyBrowser = browserCheck) {
  const [cmd, ...rest] = args,
    { positional: files, chrome, browser } = options(rest);
  const arity = { validate: 1, check: 2, finalize: 2, compare: 3, patch: 4 };
  requireValue(
    Object.hasOwn(arity, cmd) && files.length === arity[cmd],
    'Usage: malt-diagram.mjs validate MODEL | check MODEL HTML | finalize MODEL HTML | compare BASE HEAD HTML | patch MODEL PANEL REPLACEMENT HTML [--browser-check] [--browser PATH]',
  );
  if (cmd === 'validate' || cmd === 'check') {
    const input = prepare(cmd, files),
      { html, layout } = render(input.model, input.digest);
    if (cmd === 'check') same(readFileSync(files[1]), html);
    return { status: 'pass', layout, sourceSha256: input.digest, htmlSha256: hash(html) };
  }
  const sources = cmd === 'compare' ? files.slice(0, 2) : cmd === 'patch' ? [files[0], files[2]] : [files[0]];
  const paths = pathsFor(files.at(-1), sources);
  const lock = openSync(paths.lock, 'wx', 0o600);
  const receipt = {
    version: 1,
    status: 'fail',
    gates: { validate: 'pending', deliver: 'pending', check: 'pending', 'browser-check': 'pending' },
  };
  let gate = 'validate';
  try {
    const input = prepare(cmd, files);
    receipt.sourceSha256 = input.digest;
    receipt.inputSha256 = input.sources;
    const { html, layout } = render(input.model, input.digest);
    receipt.layout = layout;
    receipt.gates.validate = 'pass';
    gate = 'deliver';
    atomic(paths.output, html, (bytes) => same(bytes, html));
    receipt.gates.deliver = 'pass';
    gate = 'check';
    const delivered = readFileSync(paths.output);
    receipt.htmlSha256 = hash(delivered);
    same(delivered, html);
    if (input.delta) atomic(paths.delta, json({ ...input.delta, inputSha256: input.sources, htmlSha256: receipt.htmlSha256 }));
    receipt.gates.check = 'pass';
    gate = 'browser-check';
    if (input.model.diagrams || browser) {
      receipt.viewports = await verifyBrowser(paths.output, chrome);
      requireValue(
        receipt.viewports.length === 4 &&
          receipt.viewports.every(
            (v, i) => v.pass && v.width === [1440, 1600, 1920, 2048][i] && v.height === [900, 1000, 1080, 1320][i],
          ),
        'Browser checks failed; inspect viewport results',
      );
      same(readFileSync(paths.output), html);
      receipt.gates[gate] = 'pass';
    } else receipt.gates[gate] = 'skipped';
    receipt.status = 'pass';
    return receipt;
  } catch (error) {
    receipt.gates[gate] = 'fail';
    receipt.error = String(error);
    throw error;
  } finally {
    try {
      atomic(paths.receipt, json(receipt));
    } finally {
      closeSync(lock);
      unlinkSync(paths.lock);
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await command(process.argv.slice(2)), null, 2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
