import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const sizes = [
  [1440, 900],
  [1600, 1000],
  [1920, 1080],
  [2048, 1320],
];
function executable(choice) {
  if (choice) {
    if (!isAbsolute(choice) || !existsSync(choice)) throw new Error('Chrome path must identify an installed absolute executable');
    return choice;
  }
  const guesses =
    process.platform === 'win32'
      ? [
          join(process.env.ProgramFiles || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
          join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ];
  const path = guesses.find(existsSync);
  if (!path) throw new Error('Install Chrome/Chromium or specify --browser <absolute executable>');
  return path;
}
function connection(child) {
  let id = 0,
    pending = '',
    dead;
  const requests = new Map();
  function close(error) {
    dead = error;
    for (const request of requests.values()) request.reject(error);
    requests.clear();
  }
  child.on('error', close);
  child.on('exit', (code) => close(new Error('Chrome exited (' + code + ')')));
  const output = child.stdio[4],
    input = child.stdio[3];
  input.on('error', close);
  output.on('error', close);
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\0')) !== -1) {
      const msg = JSON.parse(pending.slice(0, end));
      pending = pending.slice(end + 1);
      const req = requests.get(msg.id);
      if (req) {
        requests.delete(msg.id);
        if (msg.error) req.reject(new Error(msg.error.message));
        else req.resolve(msg.result);
      }
    }
  });
  return (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      if (dead) {
        reject(dead);
        return;
      }
      const key = ++id;
      const timer = setTimeout(() => {
        requests.delete(key);
        reject(new Error('Chrome timed out: ' + method));
      }, 12000);
      requests.set(key, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      input.write(JSON.stringify({ id: key, method, params, sessionId }) + '\0');
    });
}
export async function browserCheck(file, choice, exerciseExports = false) {
  const chrome = executable(choice),
    profile = mkdtempSync(join(tmpdir(), 'malt-chrome-'));
  let child;
  try {
    child = spawn(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--disable-background-networking',
        '--no-default-browser-check',
        '--remote-debugging-pipe',
        '--user-data-dir=' + profile,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const send = connection(child),
      { targetId } = await send('Target.createTarget', { url: 'about:blank' }),
      { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const tab = (method, params) => send(method, params, sessionId),
      reports = [];
    for (const [width, height] of sizes) {
      await tab('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await tab('Page.navigate', { url: pathToFileURL(file).href + '?malt-check#' + width });
      // A hash-only navigation preserves the document. Open a fresh page at every viewport.
      let value;
      for (let i = 0; i < 100 && !value; i++) {
        const r = await tab('Runtime.evaluate', {
          expression: "document.querySelector('meta[name=malt-browser-result]')?.content",
          returnByValue: true,
        });
        value = r.result?.value;
        if (!value) await sleep(75);
      }
      if (!value) throw new Error('Viewer did not return a browser receipt at ' + width + '×' + height);
      const result = JSON.parse(Buffer.from(value, 'base64').toString());
      if (exerciseExports && width === sizes[0][0]) {
        const output = await tab('Runtime.evaluate', {
          awaitPromise: true,
          returnByValue: true,
          expression: `(async () => {
          const png = await window.maltEncode('png',4,[],()=>{});
          const bitmap = await createImageBitmap(png);
          const box = document.getElementById('modelSvg').viewBox.baseVal;
          const dimensions = bitmap.width === box.width*4 && bitmap.height === box.height*4;
          bitmap.close();
          const types = [];
          for (const format of ['svg','jpeg','webp','webm']) {
            const blob = await window.maltEncode(format,1,[],()=>{});
            if(!blob.size) throw new Error('Empty '+format);
            types.push(blob.type);
          }
          const entry = new ClipboardItem({'image/png':png});
          return {dimensions,types,clipboard:entry.types.includes('image/png')};
        })()`,
        });
        result.encoders = output.result?.value ?? output.exceptionDetails?.exception?.description;
        result.pass &&=
          result.encoders?.dimensions &&
          result.encoders?.clipboard &&
          result.encoders.types.join(',') === 'image/svg+xml,image/jpeg,image/webp,video/webm';
      }
      reports.push(result);
      await tab('Page.navigate', { url: 'about:blank' });
    }
    return reports;
  } finally {
    if (child?.pid && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await Promise.race([exited, sleep(1500)]);
    }
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 60 });
    } catch {
      /* Browser teardown may release its own profile later. */
    }
  }
}
