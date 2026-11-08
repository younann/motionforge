// Headless export host: loads the sandboxed stage at full size and exposes seek.
const params = new URLSearchParams(location.hash.slice(1));
const token = params.get('token'), projectId = params.get('project');
history.replaceState(null, '', location.pathname);
window.__mfState = 'loading';

const api = async path => {
  const r = await fetch(`/api${path}`, {headers: {authorization: `Bearer ${token}`}});
  if (!r.ok) throw Error(`${path}: HTTP ${r.status}`);
  return r;
};

let seq = 0;
const waiters = new Map();
const frame = document.createElement('iframe');
frame.sandbox = 'allow-scripts';
frame.src = '/stage.html';

addEventListener('message', e => {
  if (e.source !== frame.contentWindow || e.data?.source !== 'mf-stage') return;
  const m = e.data;
  if (m.type === 'error') console.error(m.message);
  if ((m.type === 'rendered' || m.type === 'loaded') && waiters.has(m.id)) { waiters.get(m.id)(); waiters.delete(m.id); }
  if (m.type === 'hello') start().catch(err => { window.__mfState = `error:${err.message}`; });
});

const call = msg => new Promise(res => { const id = ++seq; waiters.set(id, res); frame.contentWindow.postMessage({...msg, id}, '*'); });

async function start() {
  const {comp} = await (await api(`/projects/${projectId}`)).json();
  document.body.style.background = comp.background;
  frame.style.width = `${comp.width}px`;
  frame.style.height = `${comp.height}px`;
  const names = new Set();
  comp.scenes.forEach(s => s.layers.forEach(l => { if (l.type === 'image' && l.src?.startsWith('asset:')) names.add(l.src.slice(6)); if (l.type === 'ui') for (const m of `${l.html} ${l.css}`.matchAll(/asset:([A-Za-z0-9._-]+)/g)) names.add(m[1]); }));
  const assets = {};
  for (const n of names) { try { assets[n] = await (await api(`/projects/${projectId}/assets/${encodeURIComponent(n)}`)).blob(); } catch (err) { console.error(err.message); } }
  frame.contentWindow.postMessage({type: 'assets', assets}, '*');
  await call({type: 'load', comp, fit: false, editable: false});
  await call({type: 'seek', t: 0});
  window.__mfSeek = t => call({type: 'seek', t});
  window.__mfState = 'ready';
}
document.body.append(frame);
