import {spawn} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';
import {findBinary} from './media.mjs';

export function findChrome() {
  const env = process.env.MOTIONFORGE_CHROME;
  if (env && existsSync(env)) return env;
  const candidates = [];
  if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Google Chrome Canary', 'Chromium', 'Microsoft Edge', 'Brave Browser']) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`, join(homedir(), `Applications/${app}.app/Contents/MacOS/${app}`));
    }
  } else if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) candidates.push(join(r, 'Google/Chrome/Application/chrome.exe'), join(r, 'Microsoft/Edge/Application/msedge.exe'), join(r, 'Chromium/Application/chrome.exe'));
  } else {
    for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) { const p = findBinary(n); if (p) candidates.push(p); }
  }
  // Playwright-managed Chromium as a fallback.
  const pw = process.platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright') : process.platform === 'win32' ? join(process.env.LOCALAPPDATA || '', 'ms-playwright') : join(homedir(), '.cache/ms-playwright');
  try {
    for (const d of readdirSync(pw).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
      candidates.push(
        join(pw, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
        join(pw, d, 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'),
        join(pw, d, 'chrome-linux/chrome'),
        join(pw, d, 'chrome-win/chrome.exe'),
      );
    }
  } catch {}
  return candidates.find(p => existsSync(p)) || null;
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.waiting = new Map(); this.listeners = new Set();
    ws.addEventListener('message', e => {
      const msg = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString());
      if (msg.id && this.waiting.has(msg.id)) {
        const {resolve, reject} = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? reject(Error(msg.error.message)) : resolve(msg.result);
      } else for (const l of this.listeners) l(msg);
    });
    ws.addEventListener('close', () => { for (const {reject} of this.waiting.values()) reject(Error('Browser connection closed')); this.waiting.clear(); });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})}));
    return new Promise((resolve, reject) => this.waiting.set(id, {resolve, reject}));
  }
}

export async function launchChrome({width, height, scale = 1}) {
  const bin = findChrome();
  if (!bin) throw Error('Chrome or Chromium not found. Install Google Chrome, or set MOTIONFORGE_CHROME to a Chromium-based browser.');
  const profile = await mkdtemp(join(tmpdir(), 'motionforge-chrome-'));
  const args = [
    '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', '--hide-scrollbars',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--font-render-hinting=none', '--force-color-profile=srgb', `--window-size=${width},${height}`, 'about:blank',
  ];
  const proc = spawn(bin, args, {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
  const wsUrl = await new Promise((resolve, reject) => {
    let err = '';
    const timer = setTimeout(() => reject(Error(`Chrome did not start: ${err.slice(-400)}`)), 20000);
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', d => { err += d; const m = err.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('exit', code => { clearTimeout(timer); reject(Error(`Chrome exited (${code}): ${err.slice(-400)}`)); });
  });
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, {once: true}); ws.addEventListener('error', () => rej(Error('Could not connect to Chrome')), {once: true}); });
  const cdp = new CDP(ws);
  const {targetId} = await cdp.send('Target.createTarget', {url: 'about:blank'});
  const {sessionId} = await cdp.send('Target.attachToTarget', {targetId, flatten: true});
  const page = (m, p) => cdp.send(m, p, sessionId);
  await page('Page.enable');
  await page('Runtime.enable');
  await page('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor: scale, mobile: false});
  await page('Emulation.setDefaultBackgroundColorOverride', {color: {r: 0, g: 0, b: 0, a: 1}});
  const consoleLines = [];
  cdp.listeners.add(msg => {
    if (msg.method === 'Runtime.consoleAPICalled') consoleLines.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
    if (msg.method === 'Runtime.exceptionThrown') consoleLines.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
  });
  async function evaluate(expression, awaitPromise = true) {
    const r = await page('Runtime.evaluate', {expression, awaitPromise, returnByValue: true});
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async function close() {
    try { ws.close(); } catch {}
    proc.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 200));
    await rm(profile, {recursive: true, force: true}).catch(() => {});
  }
  return {page, evaluate, close, consoleLines};
}
