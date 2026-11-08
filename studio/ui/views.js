import {html, useState, useEffect, useRef} from '../vendor/preact-htm.js';
import {Btn, Icon, Seg, Modal, Toggle, ago, fmtSec} from './components.js';
import {Stage, Transport, Slate, usePlayhead} from './preview.js';
import {Composer, Chat, MediaPanel, AudioPanel} from './panels.js';
import {Timeline} from './timeline.js';
import {Inspector} from './inspector.js';
import {player} from './player.js';
import {api, post, del, blob} from './api.js';
import {timeline, splitScene, duplicateScene, deleteScene, deleteLayer, deleteAudio, findLayer, setLayer} from './ops.js';

const IDEAS = [
  'A 15-second launch ad for Stride, a minimalist running shoe. Fast, bold, energetic.',
  'Weekend flash sale: 40% off all candles at Ember & Oak. Warm, cozy, luxurious.',
  'Announce our new budgeting app, Penny: “Know where every dollar goes.” Clean and techy.',
  'A playful 10-second promo for a bubble tea shop opening on Friday.',
];

export function Home({onOpen, toast}) {
  const [list, setList] = useState(null);
  const load = () => api('/projects').then(d => setList(d.projects)).catch(e => toast(e.message, 'error'));
  useEffect(() => { load(); }, []);
  const create = async () => {
    const d = await post('/projects', {title: 'Untitled video', format: '9:16'});
    onOpen(d.project.id, 'simple');
  };
  return html`<main class="home">
    <header class="home-head">
      <div class="brand"><span class="brand-mark"></span>MotionForge</div>
    </header>
    <section class="home-hero">
      <h1>Animated ads, directed by Claude.</h1>
      <p>Describe the video or drop in an image. Claude designs the motion, picks the music and lays it all out on a timeline you can edit.</p>
      <${Btn} kind="primary" icon="plus" label="New video" onClick=${create}/>
    </section>
    <section class="home-list">
      <h2>Your videos</h2>
      ${list === null ? html`<p class="muted">Loading…</p>` : list.length === 0 ? html`<p class="muted">Nothing here yet. Your videos will show up here.</p>` : html`
      <ul class="proj-grid">${list.map(p => html`<li>
        <button class="proj" onClick=${() => onOpen(p.id, p.scenes ? 'editor' : 'simple')}>
          <span class="proj-frame"><span class="proj-shape" style=${`aspect-ratio:${p.width || 9}/${p.height || 16}`}><${Icon} name="play" size=${16}/></span></span>
          <span class="proj-title">${p.title}</span>
          <span class="proj-meta">${p.scenes ? `${p.scenes} scene${p.scenes === 1 ? '' : 's'}` : 'Empty'} · ${ago(p.updatedAt)}</span>
        </button>
        <button class="proj-del" title=${`Delete ${p.title}`} aria-label=${`Delete ${p.title}`} onClick=${async () => { if (confirm(`Delete “${p.title}”? This can't be undone.`)) { await del(`/projects/${p.id}`); load(); } }}><${Icon} name="trash" size=${14}/></button>
      </li>`)}</ul>`}
    </section>
  </main>`;
}

export function Simple({p, setMode, openExport}) {
  const c = p.comp;
  const [settings, setSettings] = useState({format: '9:16', duration: 15, style: 'auto'});
  const [seed, setSeed] = useState(0);
  const [idea, setIdea] = useState('');
  const empty = !c?.scenes.length;
  useEffect(() => { player.editable = false; }, []);
  if (empty && !p.gen) {
    return html`<main class="simple simple-empty">
      <div class="simple-hero">
        <h1>What should we make?</h1>
        <p class="lede">Describe your ad, or attach an image to animate. Claude handles the design, motion, music and sound effects.</p>
        <${Composer} key=${seed} p=${p} variant="hero" settings=${settings} setSettings=${setSettings} initial=${idea}
          placeholder="e.g. A punchy 15-second ad for our summer sale: 50% off everything, ends Sunday"/>
        <div class="ideas"><span class="muted small">Try one</span>
          ${IDEAS.map(t => html`<button class="idea" onClick=${() => { setIdea(t); setSeed(s => s + 1); }}>${t}</button>`)}
        </div>
      </div>
      <div class="offscreen"><${Stage} editable=${false}/></div>
    </main>`;
  }
  const tl = c ? timeline(c) : {items: []};
  return html`<main class="simple simple-made">
    <section class="simple-stage">
      <div class="stage-box" style=${c ? `aspect-ratio:${c.width}/${c.height}` : ''}>
        <${Stage} editable=${false}/>
        ${p.gen && html`<${Slate} gen=${p.gen} onCancel=${p.cancelGenerate}/>`}
      </div>
      <${Transport} comp=${c} compact/>
    </section>
    <aside class="simple-side">
      <h2>Refine it</h2>
      ${(() => { const m = [...(p.project?.messages || [])].reverse().find(x => x.role !== 'user'); return m && !p.gen ? html`<p class=${`last-reply${m.role === 'error' ? ' error-text' : ''}`}>${m.text}</p>` : null; })()}
      <${Composer} p=${p} variant="chat" placeholder="Make the second scene faster, use warmer colors…"/>
      ${tl.items.length > 0 && html`<div class="scene-strip">
        <h3>Scenes</h3>
        <ol>${tl.items.map(it => html`<li><button onClick=${() => player.seek(it.start + 0.01)}>
          <span class="ss-name">${it.scene.name}</span><span class="ss-len mono">${fmtSec(it.length)}</span>
        </button></li>`)}</ol>
      </div>`}
      <div class="simple-actions">
        <${Btn} kind="secondary" icon="layers" label="Edit on the timeline" onClick=${() => setMode('editor')}/>
        <${Btn} kind="primary" icon="download" label="Export video" onClick=${openExport} disabled=${!tl.items.length || !!p.gen}/>
      </div>
    </aside>
  </main>`;
}

export function Editor({p, library, openExport, toast}) {
  const c = p.comp;
  const [sel, setSelState] = useState(null);
  const [tab, setTab] = useState('claude');
  const [scope, setScope] = useState('all');
  const dragBase = useRef(null);
  const setSel = s => { setSelState(s); player.select(s?.kind === 'layer' ? s.id : null); };
  useEffect(() => { player.editable = true; }, []);

  useEffect(() => {
    player.onPick = id => {
      if (!id) { setSelState(cur => (cur?.kind === 'layer' ? {kind: 'scene', sceneId: cur.sceneId} : cur)); return; }
      const f = findLayer(p.comp, id);
      if (f) setSelState({kind: 'layer', id, sceneId: f.scene.id});
    };
    player.onDrag = m => {
      const base = dragBase.current?.id === m.layerId ? dragBase.current : (dragBase.current = {id: m.layerId, comp: p.comp, L: findLayer(p.comp, m.layerId)?.layer});
      if (!base.L) return;
      p.update(setLayer(base.comp, m.layerId, {x: Math.round(base.L.x + m.dx), y: Math.round(base.L.y + m.dy)}), {commit: false, save: false});
      if (m.done) { dragBase.current = null; p.commitNow(); }
    };
    player.onError = msg => toast(msg, 'error');
    return () => { player.onPick = null; player.onDrag = null; };
  }, [p.comp]);

  const selScene = sel && (sel.kind === 'scene' || sel.kind === 'layer') ? c?.scenes.find(s => s.id === sel.sceneId) : null;
  useEffect(() => { if (!selScene && scope === 'scene') setScope('all'); }, [selScene]);

  useEffect(() => {
    const onKey = e => {
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
      else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? p.redo() : p.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); p.redo(); }
      else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); if (selScene) p.update(duplicateScene(c, selScene.id)); }
      else if (e.key.toLowerCase() === 's' && !mod) { p.update(splitScene(c, player.t)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); player.seek(player.t - (e.shiftKey ? 1 : 1 / c.fps)); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); player.seek(player.t + (e.shiftKey ? 1 : 1 / c.fps)); }
      else if (e.key === 'Home') player.seek(0);
      else if (e.key === 'End') player.seek(player.duration);
      else if (e.key === 'Escape') setSel(null);
      else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (sel?.kind === 'layer') { p.update(deleteLayer(c, sel.id)); setSel({kind: 'scene', sceneId: sel.sceneId}); }
        else if (sel?.kind === 'scene') { p.update(deleteScene(c, sel.sceneId)); setSel(null); }
        else if (sel?.kind === 'audio') { p.update(deleteAudio(c, sel.id)); setSel(null); }
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [c, sel]);

  const askScene = s => { setTab('claude'); setScope('scene'); setTimeout(() => document.querySelector('.chat textarea')?.focus(), 30); };
  if (!c) return null;
  return html`<main class="editor">
    <aside class="panel panel-left">
      <nav class="tabs" role="tablist">
        ${[['claude', 'Claude', 'chat'], ['media', 'Media', 'image'], ['audio', 'Audio', 'music']].map(([k, l, i]) => html`
          <button role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}><${Icon} name=${i} size=${15}/>${l}</button>`)}
      </nav>
      <div class="panel-body">
        ${tab === 'claude' && html`<${Chat} p=${p} scene=${selScene} scope=${scope} setScope=${setScope}/>`}
        ${tab === 'media' && html`<${MediaPanel} p=${p} sceneId=${selScene?.id}/>`}
        ${tab === 'audio' && library && html`<${AudioPanel} p=${p} library=${library}/>`}
      </div>
    </aside>
    <section class="viewer">
      <div class="stage-area">
        <div class="stage-box" style=${`aspect-ratio:${c.width}/${c.height}`}>
          <${Stage} editable=${true}/>
          ${p.gen && html`<${Slate} gen=${p.gen} onCancel=${p.cancelGenerate}/>`}
          ${!c.scenes.length && !p.gen && html`<div class="stage-empty"><p>Describe your video in the Claude panel to get started.</p></div>`}
        </div>
      </div>
      <${Transport} comp=${c}/>
    </section>
    <aside class="panel panel-right"><${Inspector} p=${p} sel=${sel} setSel=${setSel} askScene=${askScene}/></aside>
    <section class="panel-bottom"><${Timeline} p=${p} sel=${sel} setSel=${setSel} library=${library}/></section>
  </main>`;
}

export function ExportDialog({p, onClose}) {
  const [quality, setQuality] = useState('1080');
  const [fps, setFps] = useState(String(p.comp?.fps || 30));
  const e = p.exp;
  const total = p.comp ? timeline(p.comp).total : 0;
  const dims = q => { const s = q === '4k' ? 2160 : q === '720' ? 720 : 1080; const k = s / Math.min(p.comp.width, p.comp.height); return `${Math.round(p.comp.width * k)}×${Math.round(p.comp.height * k)}`; };
  const download = async name => {
    const b = await blob(`/projects/${p.project.id}/exports/${encodeURIComponent(name)}`);
    const a = Object.assign(document.createElement('a'), {href: URL.createObjectURL(b), download: name});
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };
  const reveal = name => post(`/projects/${p.project.id}/exports/${encodeURIComponent(name)}/reveal`);
  const running = e?.running;
  return html`<${Modal} title="Export video" onClose=${() => { if (!running) { p.setExp(null); onClose(); } }}>
    ${!running && !e?.done && html`<div class="export-form">
      <div class="field-row"><span class="field-label">Resolution</span>
        <${Seg} value=${quality} onChange=${setQuality} options=${[{value: '720', label: '720p'}, {value: '1080', label: '1080p'}, {value: '4k', label: '4K'}]}/></div>
      <div class="field-row"><span class="field-label">Frame rate</span>
        <${Seg} value=${fps} onChange=${setFps} options=${['30', '60']}/></div>
      <p class="export-sum">${dims(quality)} · ${fps} fps · ${total.toFixed(1)} seconds · H.264 MP4 with audio</p>
      ${quality === '4k' || fps === '60' ? html`<p class="muted small">Higher settings take longer to render, roughly ${quality === '4k' ? '3–4' : '2'}× the time.</p>` : ''}
      ${e?.error && html`<p class="error-text">${e.error}</p>`}
      <div class="modal-actions"><${Btn} kind="primary" icon="download" label="Export" onClick=${() => p.startExport({quality, fps: Number(fps)})}/></div>
    </div>`}
    ${running && html`<div class="export-progress">
      <div class="bar"><i style=${`width:${Math.round((e.pct || 0) * 100)}%`}></i></div>
      <p>${e.phase === 'encode' ? 'Finishing the file…' : e.frames ? `Rendering frame ${e.frame} of ${e.frames}` : 'Starting the renderer…'}
        ${e.eta != null && e.phase === 'render' ? html` · about ${e.eta < 60 ? `${e.eta}s` : `${Math.ceil(e.eta / 60)} min`} left` : ''}</p>
      <div class="modal-actions"><${Btn} kind="secondary" label="Cancel" onClick=${p.cancelExport}/></div>
    </div>`}
    ${e?.done && html`<div class="export-done">
      <p class="ok-text"><${Icon} name="download"/> Exported ${e.file.width}×${e.file.height}, ${e.file.fps} fps, in ${e.file.seconds}s.</p>
      <p class="mono small">${e.file.name}</p>
      <div class="modal-actions">
        <${Btn} kind="secondary" icon="folder" label="Show in folder" onClick=${() => reveal(e.file.name)}/>
        <${Btn} kind="primary" icon="download" label="Download" onClick=${() => download(e.file.name)}/>
      </div>
    </div>`}
    ${(p.exports || []).length > 0 && !running && html`<div class="export-list"><h3>Earlier exports</h3><ul>
      ${p.exports.slice(0, 5).map(x => html`<li><span class="mono small">${x.name}</span><span class="muted small">${(x.size / 1e6).toFixed(1)} MB</span>
        <${Btn} small icon="folder" title="Show in folder" onClick=${() => reveal(x.name)}/><${Btn} small icon="download" title="Download" onClick=${() => download(x.name)}/></li>`)}
    </ul></div>`}
  <//>`;
}

export function SettingsDialog({onClose, toast}) {
  const [st, setSt] = useState(null);
  const [pol, setPol] = useState('');
  const [hf, setHf] = useState('');
  const [test, setTest] = useState(null);
  useEffect(() => { api('/settings').then(setSt).catch(e => toast(e.message, 'error')); }, []);
  const save = async patchBody => { const next = await api('/settings', {method: 'PUT', body: JSON.stringify(patchBody)}); setSt(next); return next; };
  const runTest = async () => {
    setTest({busy: true});
    try { const r = await post('/settings/test-image'); setTest(r); } catch (e) { setTest({error: e.message}); }
  };
  if (!st) return html`<${Modal} title="Settings" onClose=${onClose}><p class="muted">Loading…</p><//>`;
  return html`<${Modal} title="Settings" onClose=${onClose} width=${520}>
    <div class="settings">
      <h3>Image generation</h3>
      <p class="muted small">When a scene needs a product shot, background or object, Claude describes it and this service draws it.</p>
      <${Seg} value=${st.imageProvider} onChange=${v => save({imageProvider: v})} options=${st.providers.map(p => ({value: p.id, label: p.label}))}/>
      ${st.imageProvider === 'pollinations' && html`<div class="settings-block">
        <p class="small">Works without an account, but free images carry a small Pollinations logo. Add a free token from <span class="mono">enter.pollinations.ai</span> to remove it.</p>
        <div class="settings-row"><input class="color-text" type="password" placeholder=${st.hasPollinationsToken ? 'Token saved' : 'Pollinations token (optional)'} value=${pol} onInput=${e => setPol(e.target.value)}/>
          <${Btn} kind="secondary" small label="Save" disabled=${!pol} onClick=${async () => { await save({pollinationsToken: pol}); setPol(''); toast('Token saved', 'ok'); }}/>
          ${st.hasPollinationsToken && html`<${Btn} small label="Remove" onClick=${() => save({pollinationsToken: ''})}/>`}</div>
      </div>`}
      ${st.imageProvider === 'huggingface' && html`<div class="settings-block">
        <p class="small">Uses FLUX.1 schnell with your free Hugging Face token (create one at <span class="mono">huggingface.co/settings/tokens</span> with Inference permission).</p>
        <div class="settings-row"><input class="color-text" type="password" placeholder=${st.hasHfToken ? 'Token saved' : 'hf_…'} value=${hf} onInput=${e => setHf(e.target.value)}/>
          <${Btn} kind="secondary" small label="Save" disabled=${!hf} onClick=${async () => { await save({hfToken: hf}); setHf(''); toast('Token saved', 'ok'); }}/>
          ${st.hasHfToken && html`<${Btn} small label="Remove" onClick=${() => save({hfToken: ''})}/>`}</div>
      </div>`}
      ${st.imageProvider !== 'none' && html`<div class="settings-test">
        <${Btn} kind="secondary" small icon="image" label=${test?.busy ? 'Generating…' : 'Test image generation'} disabled=${test?.busy} onClick=${runTest}/>
        ${test?.ok && html`<span class="ok-text small">Worked in ${(test.ms / 1000).toFixed(1)}s</span>`}
        ${test?.error && html`<span class="error-text">${test.error}</span>`}
        ${test?.image && html`<img class="settings-img" src=${test.image} alt="Test result"/>`}
      </div>`}
      <h3>Quality</h3>
      <div class="field-row"><span><b>Polish pass</b><br/><span class="muted small">After generating, Claude reviews rendered frames and fixes what looks off. Adds about a minute.</span></span>
        <${Toggle} value=${st.polish} onChange=${v => save({polish: v})}/></div>
    </div>
  <//>`;
}
