import {html, useState, useRef, useEffect} from '../vendor/preact-htm.js';
import {Btn, Icon, Seg, ago} from './components.js';
import {blob} from './api.js';
import {player} from './player.js';
import {addAudio, addLayer, findSceneAt} from './ops.js';

const isImage = n => /\.(png|jpe?g|webp|gif)$/i.test(n);
const isAudio = n => /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(n);

const thumbCache = new Map();
export function Thumb({projectId, name, size = 44}) {
  const [url, setUrl] = useState(thumbCache.get(`${projectId}/${name}`) || null);
  useEffect(() => {
    if (url || !isImage(name)) return;
    let alive = true;
    blob(`/projects/${projectId}/assets/${encodeURIComponent(name)}`).then(b => { const u = URL.createObjectURL(b); thumbCache.set(`${projectId}/${name}`, u); if (alive) setUrl(u); }).catch(() => {});
    return () => { alive = false; };
  }, [name]);
  return isImage(name)
    ? html`<span class="thumb" style=${`width:${size}px;height:${size}px`}>${url && html`<img src=${url} alt=""/>`}</span>`
    : html`<span class="thumb thumb-audio" style=${`width:${size}px;height:${size}px`}><${Icon} name="music" size=${16}/></span>`;
}

export const STYLES = [
  {value: 'auto', label: 'Auto'}, {value: 'bold', label: 'Bold'}, {value: 'minimal', label: 'Minimal'}, {value: 'luxury', label: 'Luxury'},
  {value: 'playful', label: 'Playful'}, {value: 'tech', label: 'Tech'}, {value: 'cinematic', label: 'Cinematic'},
];

export function Composer({p, variant = 'chat', scene, onScopeChange, scope = 'all', settings, setSettings, placeholder, initial = ''}) {
  const [text, setText] = useState(initial);
  const [files, setFiles] = useState([]);
  const [imageMode, setImageMode] = useState('scene');
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const ta = useRef(null);
  const busy = !!p.gen;
  useEffect(() => { const el = ta.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, variant === 'hero' ? 220 : 160)}px`; }, [text]);

  async function add(list) {
    const arr = [...list].filter(f => isImage(f.name) || isAudio(f.name));
    if (!arr.length) return;
    setUploading(true);
    const names = await p.addFiles(arr);
    setUploading(false);
    setFiles(f => [...new Set([...f, ...names])]);
  }
  function submit(e) {
    e?.preventDefault();
    const prompt = text.trim();
    if (!prompt || busy) return;
    const input = {prompt, attachments: files, imageMode: files.some(isImage) ? imageMode : undefined};
    if (scope === 'scene' && scene) input.sceneId = scene.id;
    if (settings) {
      if (settings.format) input.format = settings.format;
      if (settings.duration) input.duration = settings.duration;
      if (settings.style && settings.style !== 'auto') input.style = settings.style;
    }
    setText(''); setFiles([]);
    p.generate(input);
  }
  const hasImage = files.some(isImage);
  return html`<form class=${`composer composer-${variant}${drag ? ' is-drag' : ''}`} onSubmit=${submit}
      onDragOver=${e => { e.preventDefault(); setDrag(true); }} onDragLeave=${() => setDrag(false)}
      onDrop=${e => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}>
    ${files.length > 0 && html`<div class="attachments">
      ${files.map(n => html`<span class="chip-file"><${Thumb} projectId=${p.project.id} name=${n} size=${28}/><span>${n}</span>
        <button type="button" aria-label=${`Remove ${n}`} onClick=${() => setFiles(f => f.filter(x => x !== n))}><${Icon} name="close" size=${12}/></button></span>`)}
    </div>`}
    ${hasImage && html`<div class="image-mode">
      <span>Use the image</span>
      <${Seg} value=${imageMode} onChange=${setImageMode} options=${[{value: 'scene', label: 'In the scene'}, {value: 'rebuild', label: 'Rebuild it as animation'}]}/>
    </div>`}
    <textarea ref=${ta} rows=${variant === 'hero' ? 3 : 2} value=${text} disabled=${busy}
      placeholder=${placeholder || 'Describe a change…'}
      onInput=${e => setText(e.target.value)}
      onPaste=${e => { if (e.clipboardData?.files?.length) { e.preventDefault(); add(e.clipboardData.files); } }}
      onKeyDown=${e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || (!e.shiftKey && variant !== 'hero'))) submit(e); }}></textarea>
    <div class="composer-bar">
      <label class="btn btn-ghost btn-icon" title="Attach an image or audio file">
        <${Icon} name="attach"/><input type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,audio/*" onChange=${e => { add(e.target.files); e.target.value = ''; }}/>
      </label>
      ${uploading && html`<span class="muted small">Uploading…</span>`}
      ${variant === 'chat' && scene && html`<${Seg} size="sm" value=${scope} onChange=${onScopeChange} options=${[{value: 'all', label: 'Whole video'}, {value: 'scene', label: scene.name.length > 14 ? 'This scene' : scene.name}]}/>`}
      ${variant === 'hero' && settings && html`<${HeroSettings} settings=${settings} setSettings=${setSettings}/>`}
      <span class="grow"></span>
      ${busy
        ? html`<${Btn} kind="secondary" icon="stop" label="Stop" onClick=${() => p.cancelGenerate()}/>`
        : html`<${Btn} type="submit" kind="primary" icon=${variant === 'hero' ? 'bolt' : 'send'} label=${variant === 'hero' ? 'Make it' : ''} title="Send (Enter)" disabled=${!text.trim()}/>`}
    </div>
  </form>`;
}

function HeroSettings({settings, setSettings}) {
  const set = (k, v) => setSettings(s => ({...s, [k]: v}));
  return html`<div class="hero-settings">
    <label class="pill-select"><span>Format</span><select value=${settings.format} onChange=${e => set('format', e.target.value)}>
      <option value="9:16">9:16 Story</option><option value="1:1">1:1 Square</option><option value="4:5">4:5 Feed</option><option value="16:9">16:9 Wide</option></select></label>
    <label class="pill-select"><span>Length</span><select value=${settings.duration} onChange=${e => set('duration', Number(e.target.value))}>
      ${[6, 10, 15, 20, 30].map(d => html`<option value=${d}>${d} seconds</option>`)}</select></label>
    <label class="pill-select"><span>Style</span><select value=${settings.style} onChange=${e => set('style', e.target.value)}>
      ${STYLES.map(s => html`<option value=${s.value}>${s.label}</option>`)}</select></label>
  </div>`;
}

export function Chat({p, scene, scope, setScope}) {
  const list = useRef(null);
  const msgs = p.project?.messages || [];
  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs.length, p.gen?.steps?.length]);
  return html`<div class="chat">
    <div class="chat-list" ref=${list}>
      ${!msgs.length && html`<div class="chat-empty">
        <p>Ask Claude for anything: a whole new ad, a punchier scene, different music, a new color palette.</p>
        <p class="muted">Select a scene on the timeline to change only that scene.</p>
      </div>`}
      ${msgs.map(m => html`<div class=${`msg msg-${m.role}`}>
        ${m.attachments?.length > 0 && html`<div class="msg-files">${m.attachments.map(n => html`<${Thumb} projectId=${p.project.id} name=${n} size=${36}/>`)}</div>`}
        <p>${m.text}</p>
        <span class="msg-meta">${m.sceneId ? 'One scene · ' : ''}${ago(m.at)}</span>
      </div>`)}
      ${p.gen && html`<div class="msg msg-assistant msg-live">
        <ul class="steps">${(p.gen.steps.length ? p.gen.steps : [{label: 'Starting Claude'}]).map((s, i, a) => html`<li class=${i === a.length - 1 ? 'live' : 'done'}>${s.label}</li>`)}</ul>
      </div>`}
    </div>
    <${Composer} p=${p} variant="chat" scene=${scene} scope=${scope} onScopeChange=${setScope} placeholder=${scope === 'scene' && scene ? `Change “${scene.name}”…` : 'Describe a change…'}/>
  </div>`;
}

export function MediaPanel({p, sceneId}) {
  const assets = p.assets || [];
  const add = name => {
    const c = p.comp;
    const sid = sceneId || findSceneAt(c, player.t)?.scene.id;
    if (!sid) return;
    if (isImage(name)) {
      const w = Math.round(c.width * 0.6);
      p.update(addLayer(c, sid, {type: 'image', name, src: `asset:${name}`, x: c.width / 2, y: c.height / 2, width: w, height: w, enter: {preset: 'scale', duration: 0.7}, loop: {preset: 'kenburns'}, radius: 24, shadow: '0 30px 60px rgba(0,0,0,.45)'}));
    } else {
      p.update(addAudio(c, {kind: 'voice', src: `asset:${name}`, name, start: player.t}));
    }
  };
  return html`<div class="lib">
    <label class="dropzone">
      <${Icon} name="plus"/><span>Add images or audio</span><span class="muted small">PNG, JPG, WebP, MP3, WAV, M4A</span>
      <input type="file" hidden multiple accept="image/png,image/jpeg,image/webp,image/gif,audio/*" onChange=${async e => { await p.addFiles([...e.target.files]); e.target.value = ''; }}/>
    </label>
    ${assets.length === 0 ? html`<p class="muted small pad">Uploaded files appear here. Attach them to a prompt, or add them straight to the selected scene.</p>` : html`
    <ul class="lib-list">${assets.map(n => html`<li>
      <${Thumb} projectId=${p.project.id} name=${n} size=${40}/>
      <span class="lib-name" title=${n}>${n}</span>
      <${Btn} small icon="plus" title=${isImage(n) ? 'Add to the selected scene' : 'Add to the timeline as voiceover'} onClick=${() => add(n)}/>
    </li>`)}</ul>`}
  </div>`;
}

export function AudioPanel({p, library}) {
  const [playing, setPlaying] = useState(null);
  const preview = async src => {
    if (playing === src) { player.stopPreview(); setPlaying(null); return; }
    setPlaying(src); await player.preview(src);
  };
  useEffect(() => () => player.stopPreview(), []);
  const c = p.comp;
  const music = c?.audio.find(a => a.kind === 'music');
  const useMusic = id => p.update(addAudio(c, {kind: 'music', src: `lib:music/${id}`, name: library.music.find(m => m.id === id)?.title, start: 0, fadeOut: 1.2}));
  const addSfx = id => p.update(addAudio(c, {kind: 'sfx', src: `lib:sfx/${id}`, name: library.sfx.find(m => m.id === id)?.title, start: player.t}));
  return html`<div class="lib">
    <h3 class="lib-h">Music</h3>
    <ul class="lib-list">${library.music.map(m => {
      const src = `lib:music/${m.id}`, on = music?.src === src;
      return html`<li class=${on ? 'is-on' : ''}>
        <button class="lib-play" onClick=${() => preview(src)} aria-label=${playing === src ? 'Stop preview' : `Preview ${m.title}`}><${Icon} name=${playing === src ? 'stop' : 'play'} size=${13}/></button>
        <span class="lib-name">${m.title}<small>${m.bpm} BPM · ${(m.mood || []).slice(0, 2).join(', ')}</small></span>
        ${on ? html`<span class="tag">In use</span>` : html`<${Btn} small label="Use" onClick=${() => useMusic(m.id)}/>`}
      </li>`;
    })}</ul>
    <h3 class="lib-h">Sound effects <small>added at the playhead</small></h3>
    <ul class="lib-grid">${library.sfx.map(s => {
      const src = `lib:sfx/${s.id}`;
      return html`<li>
        <button class="lib-play" onClick=${() => preview(src)} aria-label=${`Preview ${s.title}`}><${Icon} name=${playing === src ? 'stop' : 'play'} size=${12}/></button>
        <span class="lib-name">${s.title}</span>
        <${Btn} small icon="plus" title=${`Add ${s.title} at the playhead`} onClick=${() => addSfx(s.id)}/>
      </li>`;
    })}</ul>
    <p class="muted small pad">All bundled music and sound effects are original and free to use in your videos (CC0).</p>
  </div>`;
}
