import {readFile, writeFile, mkdir, readdir, rm, rename, stat} from 'node:fs/promises';
import {join, extname, basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {normalizeComp, emptyComp} from '../studio/engine/schema.js';

export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
export const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];
export const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.mp4': 'video/mp4', '.json': 'application/json',
};

export function createStore(projectsDir) {
  const safeId = id => /^[a-f0-9-]{36}$/.test(id || '');
  const dir = id => join(projectsDir, id);
  const write = async (file, data) => { const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, data, {mode: 0o600}); await rename(tmp, file); };

  async function load(id) {
    if (!safeId(id)) return null;
    try { return JSON.parse(await readFile(join(dir(id), 'project.json'), 'utf8')); } catch { return null; }
  }
  async function save(p) {
    await mkdir(dir(p.id), {recursive: true, mode: 0o700});
    p.updatedAt = new Date().toISOString();
    await write(join(dir(p.id), 'project.json'), JSON.stringify(p, null, 2));
    return p;
  }
  async function loadComp(id) {
    try { return normalizeComp(JSON.parse(await readFile(join(dir(id), 'comp.json'), 'utf8'))); } catch { return null; }
  }
  async function saveComp(id, comp) {
    const c = normalizeComp(comp);
    await write(join(dir(id), 'comp.json'), JSON.stringify(c, null, 2));
    return c;
  }
  async function snapshot(id, label) {
    const c = await loadComp(id);
    if (!c) return null;
    const hdir = join(dir(id), 'history');
    await mkdir(hdir, {recursive: true, mode: 0o700});
    const name = `${Date.now()}.json`;
    await writeFile(join(hdir, name), JSON.stringify({label, comp: c}), {mode: 0o600});
    const files = (await readdir(hdir)).filter(f => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 30))) await rm(join(hdir, f), {force: true});
    return name;
  }
  async function history(id) {
    const hdir = join(dir(id), 'history');
    try {
      const files = (await readdir(hdir)).filter(f => f.endsWith('.json')).sort().reverse();
      return Promise.all(files.map(async f => ({id: f, at: new Date(Number(f.split('.')[0])).toISOString(), label: JSON.parse(await readFile(join(hdir, f), 'utf8')).label})));
    } catch { return []; }
  }
  async function restore(id, file) {
    if (!/^\d+\.json$/.test(file)) return null;
    const {comp} = JSON.parse(await readFile(join(dir(id), 'history', file), 'utf8'));
    await snapshot(id, 'Before restore');
    return saveComp(id, comp);
  }
  async function create({title = 'Untitled', format = '9:16'} = {}) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const p = {id, title: String(title).slice(0, 100), createdAt: now, updatedAt: now, sessionId: null, messages: []};
    await mkdir(join(dir(id), 'assets'), {recursive: true, mode: 0o700});
    await save(p);
    await saveComp(id, emptyComp(format, p.title));
    return p;
  }
  async function list() {
    let dirs = [];
    try { dirs = await readdir(projectsDir, {withFileTypes: true}); } catch { return []; }
    const items = await Promise.all(dirs.filter(d => d.isDirectory()).map(async d => {
      const p = await load(d.name);
      if (!p) return null;
      const c = await loadComp(p.id);
      return {id: p.id, title: p.title, updatedAt: p.updatedAt, scenes: c?.scenes.length || 0, width: c?.width, height: c?.height};
    }));
    return items.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async function remove(id) { if (safeId(id)) await rm(dir(id), {recursive: true, force: true}); }

  const cleanName = name => {
    const ext = extname(name).toLowerCase();
    const base = basename(name, extname(name)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'file';
    return {base, ext};
  };
  async function addAsset(id, name, data) {
    const {base, ext} = cleanName(name);
    if (![...IMAGE_EXT, ...AUDIO_EXT].includes(ext)) throw Error(`Unsupported file type ${ext || '(none)'}`);
    const adir = join(dir(id), 'assets');
    await mkdir(adir, {recursive: true, mode: 0o700});
    let final = `${base}${ext}`, n = 1;
    while (await stat(join(adir, final)).then(() => true, () => false)) final = `${base}-${++n}${ext}`;
    await writeFile(join(adir, final), data, {mode: 0o600});
    return final;
  }
  const assetPath = (id, name) => (/^[a-z0-9._-]+$/i.test(name) && !name.startsWith('.') ? join(dir(id), 'assets', name) : null);
  async function assets(id) {
    try { return (await readdir(join(dir(id), 'assets'))).filter(f => !f.startsWith('.')); } catch { return []; }
  }
  const exportPath = (id, name) => (/^[a-z0-9._-]+\.mp4$/i.test(name) ? join(dir(id), 'exports', name) : null);
  async function exports(id) {
    try {
      const files = (await readdir(join(dir(id), 'exports'))).filter(f => f.endsWith('.mp4'));
      return (await Promise.all(files.map(async f => ({name: f, size: (await stat(join(dir(id), 'exports', f))).size})))).sort((a, b) => b.name.localeCompare(a.name));
    } catch { return []; }
  }

  return {safeId, dir, load, save, loadComp, saveComp, snapshot, history, restore, create, list, remove, addAsset, assetPath, assets, exportPath, exports};
}
