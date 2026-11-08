import http from 'node:http';
import {readFile, stat, mkdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {homedir} from 'node:os';
import {join, dirname, extname, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createStore, MIME} from './store.mjs';
import {generate} from './director.mjs';
import {exportVideo} from './exporter.mjs';
import {findChrome} from './chrome.mjs';
import {findBinary} from './media.mjs';
import {PROVIDERS, resolveImages} from './images.mjs';
import {writeFile} from 'node:fs/promises';
import {normalizeComp, FORMATS} from '../studio/engine/schema.js';

const VERSION = '0.3.0';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stateDir = process.env.MOTIONFORGE_HOME || join(homedir(), '.motionforge');
const config = JSON.parse(await readFile(join(stateDir, 'server.json'), 'utf8'));
const port = config.port;
const origin = `http://127.0.0.1:${port}`;
const projectsDir = join(stateDir, 'projects');
await mkdir(projectsDir, {recursive: true, mode: 0o700});
const store = createStore(projectsDir);
const jobs = new Map();
const busy = new Map();

const settingsFile = join(stateDir, 'settings.json');
const DEFAULT_SETTINGS = {imageProvider: 'pollinations', polish: true, pollinationsToken: '', hfToken: ''};
async function getSettings() {
  try { return {...DEFAULT_SETTINGS, ...JSON.parse(await readFile(settingsFile, 'utf8'))}; } catch { return {...DEFAULT_SETTINGS}; }
}
const publicSettings = st => ({imageProvider: st.imageProvider, polish: st.polish, hasPollinationsToken: !!st.pollinationsToken, hasHfToken: !!st.hfToken,
  providers: [...Object.entries(PROVIDERS).map(([id, p]) => ({id, label: p.label})), {id: 'none', label: 'Off'}]});

let library = null;
async function getLibrary() {
  if (library) return library;
  try { library = JSON.parse(await readFile(join(root, 'assets', 'audio', 'manifest.json'), 'utf8')); } catch { return {music: [], sfx: []}; }
  return library;
}
async function resolveAudio(projectId, src) {
  if (src.startsWith('asset:')) return store.assetPath(projectId, src.slice(6));
  const m = src.match(/^lib:(music|sfx)\/([a-z0-9-]+)$/i);
  if (!m) return null;
  const lib = await getLibrary();
  const item = (m[1] === 'music' ? lib.music : lib.sfx).find(x => x.id === m[2]);
  return item ? join(root, 'assets', 'audio', item.file) : null;
}

const SEC = {'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'cross-origin'};
const json = (res, status, data) => { res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC}); res.end(JSON.stringify(data)); };
const STUDIO_CSP = `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; frame-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'`;
// The stage frame is sandboxed: no network, only bundled fonts and scripts.
const STAGE_CSP = `default-src 'none'; script-src ${origin} 'unsafe-eval'; style-src ${origin} 'unsafe-inline'; font-src ${origin}; img-src blob: data:; connect-src 'none'; base-uri 'none'; form-action 'none'`;

function authorized(req) {
  const h = req.headers.authorization || '';
  const actual = Buffer.from(h.replace(/^Bearer /, ''));
  const expected = Buffer.from(config.token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const validOrigin = req => !req.headers.origin || req.headers.origin === origin;

async function readBody(req, limit) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(Error('Body too large'), {status: 413}); chunks.push(c); }
  return Buffer.concat(chunks);
}
const readJson = async (req, limit = 2_000_000) => JSON.parse((await readBody(req, limit)).toString('utf8') || '{}');

const STATIC_TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg'};
async function serveFile(req, res, file, {csp, cors, cache = 'no-cache'} = {}) {
  let info;
  try { info = await stat(file); if (!info.isFile()) throw 0; } catch { return json(res, 404, {error: 'Not found'}); }
  const ext = extname(file).toLowerCase();
  const type = STATIC_TYPES[ext] || MIME[ext] || 'application/octet-stream';
  const headers = {'content-type': type + (/^text|json|javascript/.test(type) ? '; charset=utf-8' : ''), 'cache-control': cache, 'accept-ranges': 'bytes', ...SEC};
  if (csp) headers['content-security-policy'] = csp;
  if (cors) headers['access-control-allow-origin'] = '*';
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : info.size - 1;
    start = Math.max(0, start); end = Math.min(info.size - 1, end);
    res.writeHead(206, {...headers, 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1});
    return createReadStream(file, {start, end}).pipe(res);
  }
  res.writeHead(200, {...headers, 'content-length': info.size});
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}
function within(base, rel) {
  const p = resolve(base, '.' + sep + decodeURIComponent(rel));
  return p.startsWith(base + sep) ? p : null;
}

function newJob(kind, projectId) {
  const job = {id: randomUUID(), kind, projectId, status: 'running', events: [], listeners: new Set(), controller: new AbortController()};
  jobs.set(job.id, job);
  return job;
}
function emit(job, event) {
  const payload = {...event, at: Date.now()};
  if (event.type !== 'progress') { job.events.push(payload); if (job.events.length > 300) job.events.shift(); }
  else job.lastProgress = payload;
  for (const res of job.listeners) res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function finish(job, status) {
  job.status = status;
  for (const c of job.listeners) c.end();
  job.listeners.clear();
  setTimeout(() => jobs.delete(job.id), 600000).unref();
}

async function projectPayload(id) {
  const p = await store.load(id);
  if (!p) return null;
  return {project: p, comp: await store.loadComp(id), assets: await store.assets(id), exports: await store.exports(id), busy: busy.get(id) || null};
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    const path = url.pathname;
    if (req.method === 'GET' || req.method === 'HEAD') {
      const studio = join(root, 'studio');
      if (path === '/' || path === '/index.html') return serveFile(req, res, join(studio, 'index.html'), {csp: STUDIO_CSP});
      if (path === '/stage.html') return serveFile(req, res, join(studio, 'stage.html'), {csp: STAGE_CSP, cors: true});
      if (path === '/export.html') return serveFile(req, res, join(studio, 'export.html'), {csp: STUDIO_CSP});
      if (/^\/(app\.js|style\.css|export\.js)$/.test(path)) return serveFile(req, res, join(studio, path.slice(1)));
      if (path === '/fonts.css') return serveFile(req, res, join(studio, 'fonts.css'), {cors: true});
      for (const [prefix, base, cors] of [['/engine/', join(studio, 'engine'), true], ['/ui/', join(studio, 'ui'), false], ['/vendor/', join(studio, 'vendor'), true], ['/fonts/', join(root, 'assets', 'fonts'), true], ['/audio/', join(root, 'assets', 'audio'), false]]) {
        if (path.startsWith(prefix)) {
          const file = within(base, path.slice(prefix.length));
          return file ? serveFile(req, res, file, {cors, cache: prefix === '/fonts/' || prefix === '/audio/' ? 'max-age=86400' : 'no-cache'}) : json(res, 404, {error: 'Not found'});
        }
      }
    }
    if (!path.startsWith('/api/')) return json(res, 404, {error: 'Not found'});
    if (!validOrigin(req)) return json(res, 403, {error: 'Invalid origin'});
    if (!authorized(req)) return json(res, 401, {error: 'Unauthorized. Run /motionforge:open again.'});

    if (req.method === 'GET' && path === '/api/health') return json(res, 200, {app: 'motionforge', version: VERSION});
    if (req.method === 'GET' && path === '/api/system') {
      return json(res, 200, {version: VERSION, chrome: !!findChrome(), ffmpeg: !!findBinary('ffmpeg'), claude: !!(process.env.MOTIONFORGE_CLAUDE_BIN || findBinary('claude', [join(homedir(), '.local/bin'), join(homedir(), '.claude/local')]))});
    }
    if (req.method === 'GET' && path === '/api/settings') return json(res, 200, publicSettings(await getSettings()));
    if (req.method === 'PUT' && path === '/api/settings') {
      const input = await readJson(req);
      const st = await getSettings();
      if (input.imageProvider && (PROVIDERS[input.imageProvider] || input.imageProvider === 'none')) st.imageProvider = input.imageProvider;
      if (typeof input.polish === 'boolean') st.polish = input.polish;
      for (const k of ['pollinationsToken', 'hfToken']) if (typeof input[k] === 'string') st[k] = input[k].trim().slice(0, 300);
      await writeFile(settingsFile, JSON.stringify(st, null, 2), {mode: 0o600});
      return json(res, 200, publicSettings(st));
    }
    if (req.method === 'POST' && path === '/api/settings/test-image') {
      const st = await getSettings();
      const p = PROVIDERS[st.imageProvider];
      if (!p) return json(res, 400, {error: 'Image generation is off'});
      const t0 = Date.now();
      try { const img = await p.generate({prompt: 'studio product photo of a glossy orange sneaker on a pastel blue background, soft light', width: 512, height: 512, seed: 7, settings: st}); return json(res, 200, {ok: true, ms: Date.now() - t0, bytes: img.data.length, image: `data:${img.type};base64,${img.data.toString('base64')}`}); }
      catch (e) { return json(res, 502, {error: e.message}); }
    }
    if (req.method === 'GET' && path === '/api/library') return json(res, 200, {...(await getLibrary()), formats: FORMATS});
    if (req.method === 'GET' && path === '/api/projects') return json(res, 200, {projects: await store.list()});
    if (req.method === 'POST' && path === '/api/projects') {
      const input = await readJson(req);
      const p = await store.create({title: String(input.title || 'Untitled'), format: FORMATS[input.format] ? input.format : '9:16'});
      return json(res, 201, await projectPayload(p.id));
    }

    let m = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (m) {
      const id = m[1], sub = m[2] || '';
      const p = await store.load(id);
      if (!p) return json(res, 404, {error: 'Project not found'});
      if (!sub && req.method === 'GET') return json(res, 200, await projectPayload(id));
      if (!sub && req.method === 'PATCH') {
        const input = await readJson(req);
        if (input.title) p.title = String(input.title).slice(0, 100);
        await store.save(p);
        return json(res, 200, {project: p});
      }
      if (!sub && req.method === 'DELETE') {
        if (busy.has(id)) return json(res, 409, {error: 'Project is busy'});
        await store.remove(id);
        return json(res, 200, {ok: true});
      }
      if (sub === '/comp' && req.method === 'PUT') {
        if (busy.get(id) === 'generate') return json(res, 409, {error: 'Claude is working on this project'});
        const input = await readJson(req, 5_000_000);
        const comp = await store.saveComp(id, normalizeComp(input.comp));
        await store.save(p);
        return json(res, 200, {comp});
      }
      if (sub === '/images' && req.method === 'POST') {
        if (busy.has(id)) return json(res, 409, {error: `Project is busy (${busy.get(id)})`});
        busy.set(id, 'images');
        try {
          const comp = await store.loadComp(id);
          const out = await resolveImages({comp, projectDir: store.dir(id), settings: await getSettings()});
          const saved = await store.saveComp(id, comp);
          return json(res, 200, {comp: saved, generated: out.generated, failed: out.failed, assets: await store.assets(id)});
        } finally { busy.delete(id); }
      }
      if (sub === '/history' && req.method === 'GET') return json(res, 200, {history: await store.history(id)});
      const hm = sub.match(/^\/history\/(\d+\.json)\/restore$/);
      if (hm && req.method === 'POST') { const comp = await store.restore(id, hm[1]); return comp ? json(res, 200, {comp}) : json(res, 404, {error: 'Not found'}); }
      if (sub === '/assets' && req.method === 'POST') {
        const name = decodeURIComponent(String(req.headers['x-filename'] || 'file'));
        const data = await readBody(req, 80_000_000);
        if (!data.length) return json(res, 400, {error: 'Empty file'});
        const saved = await store.addAsset(id, name, data);
        return json(res, 201, {name: saved, assets: await store.assets(id)});
      }
      const am = sub.match(/^\/assets\/([^/]+)$/);
      if (am && req.method === 'GET') {
        const file = store.assetPath(id, decodeURIComponent(am[1]));
        return file ? serveFile(req, res, file, {cache: 'no-store'}) : json(res, 404, {error: 'Not found'});
      }
      const em = sub.match(/^\/exports\/([^/]+?)(\/reveal)?$/);
      if (em) {
        const file = store.exportPath(id, decodeURIComponent(em[1]));
        if (!file) return json(res, 404, {error: 'Not found'});
        if (em[2] && req.method === 'POST') {
          const cmd = process.platform === 'darwin' ? ['open', ['-R', file]] : process.platform === 'win32' ? ['explorer', [`/select,${file}`]] : ['xdg-open', [dirname(file)]];
          spawn(cmd[0], cmd[1], {detached: true, stdio: 'ignore'}).on('error', () => {}).unref();
          return json(res, 200, {ok: true});
        }
        if (req.method === 'GET') return serveFile(req, res, file, {cache: 'no-store'});
      }
      if (sub === '/generate' && req.method === 'POST') {
        if (busy.has(id)) return json(res, 409, {error: `Project is busy (${busy.get(id)})`});
        const input = await readJson(req);
        const prompt = String(input.prompt || '').trim();
        if (!prompt || prompt.length > 12000) return json(res, 400, {error: 'Prompt must be 1–12000 characters'});
        const attachments = Array.isArray(input.attachments) ? input.attachments.filter(a => store.assetPath(id, a)).slice(0, 10) : [];
        const job = newJob('generate', id);
        busy.set(id, 'generate');
        p.messages.push({role: 'user', text: prompt, attachments, sceneId: input.sceneId || null, at: new Date().toISOString()});
        await store.save(p);
        json(res, 202, {jobId: job.id});
        void (async () => {
          try {
            emit(job, {type: 'status', status: 'running'});
            const result = await generate({store, project: p, root, library: await getLibrary(), settings: await getSettings(), origin, token: config.token, signal: job.controller.signal, onEvent: e => emit(job, e),
              input: {prompt, attachments, imageMode: input.imageMode, duration: Number(input.duration) || null, style: input.style, sceneId: input.sceneId, format: input.format}});
            p.messages.push({role: 'assistant', text: result.text || 'Done.', at: new Date().toISOString(), usage: result.usage});
            if (/^untitled/i.test(p.title) && result.comp.title && !/^untitled/i.test(result.comp.title)) p.title = result.comp.title.slice(0, 100);
            await store.save(p);
            emit(job, {type: 'done', status: 'completed', text: result.text, comp: result.comp});
            finish(job, 'completed');
          } catch (e) {
            const cancelled = job.controller.signal.aborted;
            p.messages.push({role: 'error', text: cancelled ? 'Generation cancelled.' : String(e.message).slice(0, 2000), at: new Date().toISOString()});
            await store.save(p).catch(() => {});
            emit(job, {type: 'error', status: cancelled ? 'cancelled' : 'failed', message: String(e.message).slice(0, 2000)});
            finish(job, cancelled ? 'cancelled' : 'failed');
          } finally { busy.delete(id); }
        })();
        return;
      }
      if (sub === '/export' && req.method === 'POST') {
        if (busy.has(id)) return json(res, 409, {error: `Project is busy (${busy.get(id)})`});
        const input = await readJson(req);
        const comp = await store.loadComp(id);
        const job = newJob('export', id);
        busy.set(id, 'export');
        json(res, 202, {jobId: job.id});
        void (async () => {
          try {
            const out = await exportVideo({comp, projectId: id, projectDir: store.dir(id), origin, token: config.token, quality: input.quality, fps: input.fps,
              resolveAudio: src => resolveAudio(id, src), signal: job.controller.signal, onProgress: pr => emit(job, {type: 'progress', ...pr})});
            emit(job, {type: 'done', status: 'completed', file: out});
            finish(job, 'completed');
          } catch (e) {
            const cancelled = job.controller.signal.aborted;
            emit(job, {type: 'error', status: cancelled ? 'cancelled' : 'failed', message: String(e.message).slice(0, 2000)});
            finish(job, cancelled ? 'cancelled' : 'failed');
          } finally { busy.delete(id); }
        })();
        return;
      }
      return json(res, 404, {error: 'Not found'});
    }

    m = path.match(/^\/api\/jobs\/([^/]+)(\/events|\/cancel)?$/);
    if (m) {
      const job = jobs.get(m[1]);
      if (!job) return json(res, 404, {error: 'Job not found'});
      if (req.method === 'GET' && m[2] === '/events') {
        res.writeHead(200, {'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no'});
        for (const e of job.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        if (job.lastProgress && job.status === 'running') res.write(`data: ${JSON.stringify(job.lastProgress)}\n\n`);
        if (job.status !== 'running') return res.end();
        job.listeners.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => { clearInterval(ping); job.listeners.delete(res); });
        return;
      }
      if (req.method === 'POST' && m[2] === '/cancel') { job.controller.abort(); return json(res, 202, {status: 'cancelling'}); }
      if (req.method === 'GET' && !m[2]) return json(res, 200, {status: job.status, kind: job.kind, events: job.events});
    }
    return json(res, 404, {error: 'Not found'});
  } catch (e) {
    if (!res.headersSent) json(res, e.status || (e instanceof SyntaxError ? 400 : 500), {error: String(e.message)});
    else res.end();
  }
});
server.on('error', e => { console.error(e.message); process.exit(1); });
server.listen(port, '127.0.0.1', () => console.log(`MotionForge ${VERSION} on ${origin}`));
