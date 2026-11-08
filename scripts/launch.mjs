import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir, readFile, writeFile, open as openFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const stateDir = process.env.MOTIONFORGE_HOME || join(homedir(), '.motionforge');
const conf = join(stateDir, 'server.json');
const port = Number(process.env.MOTIONFORGE_PORT || 4173);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid MOTIONFORGE_PORT');
const base = `http://127.0.0.1:${port}`;
const noOpen = process.argv.includes('--no-open') || process.env.MOTIONFORGE_NO_OPEN === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function health(token) {
  try {
    const r = await fetch(`${base}/api/health`, {headers: {authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(900)});
    if (!r.ok) return null;
    const j = await r.json();
    return j.app === 'motionforge' ? j : null;
  } catch { return null; }
}
function openBrowser(url) {
  if (noOpen) return;
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try { const p = spawn(cmd, args, {detached: true, stdio: 'ignore', windowsHide: true}); p.on('error', () => {}); p.unref(); }
  catch { console.error('Could not open the browser automatically; use the URL below.'); }
}

await mkdir(stateDir, {recursive: true, mode: 0o700});
let state;
try { state = JSON.parse(await readFile(conf, 'utf8')); } catch {}
if (state?.port === port && typeof state.token === 'string') {
  const h = await health(state.token);
  if (h && h.version === pkg.version) {
    const url = `${base}/#token=${encodeURIComponent(state.token)}`;
    openBrowser(url);
    console.log(`MotionForge already running: ${url}`);
    process.exit(0);
  }
  // Stale version: stop it before starting the new one.
  if (h && state.pid) {
    try { process.kill(state.pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 25 && (await health(state.token)); i++) await sleep(120);
  }
}

const token = randomBytes(32).toString('hex');
await writeFile(conf, JSON.stringify({port, token}, null, 2), {mode: 0o600});
const log = await openFile(join(stateDir, 'server.log'), 'a', 0o600);
const env = {...process.env, MOTIONFORGE_HOME: stateDir, MOTIONFORGE_PORT: String(port)};
// Independent daemon, not tied to this terminal session.
delete env.CLAUDECODE;
const child = spawn(process.execPath, [join(root, 'server', 'index.mjs')], {cwd: root, env, detached: true, stdio: ['ignore', log.fd, log.fd], windowsHide: true});
child.unref();
await log.close();
await writeFile(conf, JSON.stringify({port, token, pid: child.pid}, null, 2), {mode: 0o600});
let ready = false;
for (let i = 0; i < 60; i++) { if (await health(token)) { ready = true; break; } await sleep(120); }
if (!ready) throw Error(`MotionForge failed to start. Check ${join(stateDir, 'server.log')}. Port ${port} may be in use (set MOTIONFORGE_PORT).`);
const url = `${base}/#token=${token}`;
openBrowser(url);
console.log(`MotionForge Studio: ${url}`);
console.log('The local service keeps running after this command exits.');
