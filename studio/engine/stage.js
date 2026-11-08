// Runs inside the sandboxed stage frame. Talks to the studio via postMessage only.
import {createRenderer} from './render.js';

const wrap = document.getElementById('wrap');
const stage = document.getElementById('stage');
const sel = document.getElementById('sel');
const urls = new Map();
let fit = true, selected = null, lastT = 0, editable = false;
const post = m => parent.postMessage({source: 'mf-stage', ...m}, '*');

const renderer = createRenderer(stage, {
  resolveAsset: src => (src?.startsWith('asset:') ? urls.get(src.slice(6)) || null : null),
  onError: message => post({type: 'error', message}),
});

function layout() {
  const c = renderer.comp;
  if (!c) return;
  if (!fit) { wrap.style.transform = ''; return; }
  const k = Math.min(innerWidth / c.width, innerHeight / c.height);
  const x = (innerWidth - c.width * k) / 2, y = (innerHeight - c.height * k) / 2;
  wrap.style.transform = `translate(${x}px,${y}px) scale(${k})`;
  drawSelection();
}
addEventListener('resize', layout);

function drawSelection() {
  const node = selected && stage.querySelector(`[data-id="${CSS.escape(selected)}"]`);
  if (!editable || !node || node.style.visibility === 'hidden' || node.classList.contains('mf-background')) { sel.style.display = 'none'; return; }
  const r = node.getBoundingClientRect();
  Object.assign(sel.style, {display: 'block', left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width}px`, height: `${r.height}px`});
}

function frames(n = 2) { return new Promise(res => { const step = () => (n-- <= 0 ? res() : requestAnimationFrame(step)); requestAnimationFrame(step); }); }

addEventListener('message', async e => {
  const m = e.data;
  if (!m || typeof m !== 'object' || e.source !== parent) return;
  if (m.type === 'assets') {
    for (const [name, blob] of Object.entries(m.assets || {})) {
      if (urls.has(name)) URL.revokeObjectURL(urls.get(name));
      urls.set(name, URL.createObjectURL(blob));
    }
  }
  if (m.type === 'load') {
    fit = m.fit !== false;
    editable = !!m.editable;
    document.body.classList.toggle('edit', editable);
    renderer.load(m.comp);
    layout();
    renderer.render(lastT);
    await renderer.ready();
    renderer.render(lastT);
    drawSelection();
    post({type: 'loaded', id: m.id});
  }
  if (m.type === 'seek') {
    lastT = m.t;
    renderer.render(m.t);
    drawSelection();
    if (m.id != null) {
      await renderer.ready();
      renderer.render(m.t);
      await frames(2);
      post({type: 'rendered', id: m.id});
    }
  }
  if (m.type === 'select') { selected = m.layerId || null; drawSelection(); }
});

// Click to select, drag to move.
let drag = null;
stage.addEventListener('pointerdown', e => {
  if (!editable) return;
  const node = e.target.closest('.mf-layer[data-id]');
  if (!node || node.classList.contains('mf-background')) { post({type: 'pick', layerId: null}); return; }
  const id = node.dataset.id;
  selected = id; drawSelection();
  post({type: 'pick', layerId: id});
  const k = wrap.getBoundingClientRect().width / renderer.comp.width;
  drag = {id, x: e.clientX, y: e.clientY, k, node, moved: false};
  node.classList.add('dragging');
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = (e.clientX - drag.x) / drag.k, dy = (e.clientY - drag.y) / drag.k;
  if (!drag.moved && Math.hypot(dx, dy) < 3) return;
  drag.moved = true;
  post({type: 'drag', layerId: drag.id, dx, dy, done: false});
});
stage.addEventListener('pointerup', e => {
  if (!drag) return;
  if (drag.moved) post({type: 'drag', layerId: drag.id, dx: (e.clientX - drag.x) / drag.k, dy: (e.clientY - drag.y) / drag.k, done: true});
  drag.node.classList.remove('dragging');
  drag = null;
});

post({type: 'hello'});
