import {html} from '../vendor/preact-htm.js';
import {Btn, Field, Num, Select, Color, Range, Toggle, Icon} from './components.js';
import {FONTS, TRANSITIONS, ENTER_PRESETS, EXIT_PRESETS, LOOP_PRESETS, EASINGS, FORMATS, EFFECTS, DEVICES} from '../engine/schema.js';
import {setScene, setLayer, setAudio, deleteLayer, moveLayer, deleteScene, duplicateScene, deleteAudio, findLayer, playable, addLayer, setFormat, timeline} from './ops.js';
import {player} from './player.js';

const label = s => s.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
const opt = list => list.map(v => ({value: v, label: label(v)}));
const LAYER_ICON = {text: 'text', image: 'image', shape: 'shape', background: 'layers', code: 'wand', ui: 'copy', effect: 'bolt', cursor: 'send'};

export function Inspector({p, sel, setSel, askScene}) {
  const c = p.comp;
  if (!c) return null;
  const live = (fn) => p.update(fn, {commit: false});
  const commit = () => p.commitNow();
  if (sel?.kind === 'layer') {
    const f = findLayer(c, sel.id);
    if (f) return html`<${LayerInspector} p=${p} scene=${f.scene} L=${f.layer} live=${live} commit=${commit} setSel=${setSel}/>`;
  }
  if (sel?.kind === 'scene') {
    const s = c.scenes.find(x => x.id === sel.sceneId);
    if (s) return html`<${SceneInspector} p=${p} s=${s} live=${live} commit=${commit} setSel=${setSel} askScene=${askScene}/>`;
  }
  if (sel?.kind === 'audio') {
    const a = c.audio.find(x => x.id === sel.id);
    if (a) return html`<${AudioInspector} p=${p} a=${a} live=${live} commit=${commit} setSel=${setSel}/>`;
  }
  return html`<${CompInspector} p=${p} live=${live} commit=${commit}/>`;
}

function Section({title, children, actions}) {
  return html`<section class="insp-sec"><header><h3>${title}</h3>${actions}</header><div class="insp-grid">${children}</div></section>`;
}

function CompInspector({p, live, commit}) {
  const c = p.comp;
  const fmt = Object.entries(FORMATS).find(([, v]) => v.width === c.width && v.height === c.height)?.[0] || 'custom';
  return html`<div class="insp">
    <div class="insp-head"><span class="insp-kind">Video</span><h2>${c.title}</h2></div>
    <${Section} title="Output">
      <${Field} label="Format" wide><${Select} value=${fmt} options=${[...Object.keys(FORMATS).map(k => ({value: k, label: `${k}  (${FORMATS[k].width}×${FORMATS[k].height})`})), ...(fmt === 'custom' ? [{value: 'custom', label: 'Custom'}] : [])]} onChange=${v => p.update(setFormat(c, v))}/><//>
      <${Field} label="Frame rate"><${Select} value=${String(c.fps)} options=${['24', '25', '30', '60']} onChange=${v => p.update({...c, fps: Number(v)})}/><//>
      <${Field} label="Length"><div class="readout mono">${timeline(c).total.toFixed(2)}s</div><//>
      <${Field} label="Backdrop" wide><${Color} value=${c.background} onChange=${(v, done) => (done ? p.update({...c, background: v}) : live({...c, background: v}))}/><//>
    <//>
    <p class="insp-tip">Click a scene on the timeline or an element in the preview to edit it. Drag elements in the preview to move them.</p>
    <div class="insp-keys">
      <span><kbd>Space</kbd> Play / pause</span><span><kbd>S</kbd> Split</span><span><kbd>←</kbd><kbd>→</kbd> Step a frame</span>
      <span><kbd>⌘Z</kbd> Undo</span><span><kbd>⌘D</kbd> Duplicate</span><span><kbd>⌫</kbd> Delete</span>
    </div>
  </div>`;
}

function SceneInspector({p, s, live, commit, setSel, askScene}) {
  const c = p.comp;
  const set = (patch, done) => (done ? p.update(setScene(c, s.id, patch)) : live(setScene(c, s.id, patch)));
  const idx = c.scenes.indexOf(s);
  return html`<div class="insp">
    <div class="insp-head"><span class="insp-kind">Scene ${idx + 1}</span>
      <input class="insp-title" value=${s.name} onChange=${e => set({name: e.target.value}, true)} aria-label="Scene name"/>
      <div class="insp-actions">
        <${Btn} small icon="wand" label="Ask Claude" title="Change this scene with a prompt" onClick=${() => askScene(s)}/>
        <${Btn} small icon="copy" title="Duplicate scene" onClick=${() => p.update(duplicateScene(c, s.id))}/>
        <${Btn} small icon="trash" title="Delete scene" onClick=${() => { p.update(deleteScene(c, s.id)); setSel(null); }}/>
      </div>
    </div>
    <${Section} title="Timing">
      <${Field} label="Length on timeline"><div class="readout mono">${playable(s).toFixed(2)}s</div><//>
      <${Field} label="Speed"><${Num} value=${s.speed} step=${0.05} min=${0.25} max=${4} unit="×" onInput=${v => set({speed: v})} onCommit=${commit}/><//>
      <${Field} label="Trim start"><${Num} value=${s.trimStart} step=${0.05} min=${0} unit="s" onInput=${v => set({trimStart: v})} onCommit=${commit}/><//>
      <${Field} label="Trim end"><${Num} value=${s.trimEnd} step=${0.05} min=${0} unit="s" onInput=${v => set({trimEnd: v})} onCommit=${commit}/><//>
      <${Field} label="Scene length" hint="Before trims"><${Num} value=${s.duration} step=${0.1} min=${0.2} max=${30} unit="s" onInput=${v => set({duration: v})} onCommit=${commit}/><//>
    <//>
    ${idx > 0 && html`<${Section} title="Transition in">
      <${Field} label="Type"><${Select} value=${s.transition.type} options=${opt(TRANSITIONS)} onChange=${v => set({transition: {...s.transition, type: v}}, true)}/><//>
      <${Field} label="Duration"><${Num} value=${s.transition.duration} step=${0.05} min=${0.05} max=${3} unit="s" onInput=${v => set({transition: {...s.transition, duration: v}})} onCommit=${commit}/><//>
      <${Field} label="Easing" wide><${Select} value=${s.transition.ease} options=${opt(EASINGS)} onChange=${v => set({transition: {...s.transition, ease: v}}, true)}/><//>
    <//>`}
    <${Section} title="Crop" actions=${(s.crop.zoom !== 1 || s.crop.x || s.crop.y) && html`<button class="link small" onClick=${() => set({crop: {zoom: 1, x: 0, y: 0}}, true)}>Reset</button>`}>
      <${Field} label="Zoom" wide><${Range} value=${s.crop.zoom} min=${1} max=${3} step=${0.01} onInput=${v => set({crop: {...s.crop, zoom: v}})} onCommit=${commit}/><//>
      <${Field} label="Pan X" wide><${Range} value=${s.crop.x} min=${-1} max=${1} step=${0.01} onInput=${v => set({crop: {...s.crop, x: v}})} onCommit=${commit}/><//>
      <${Field} label="Pan Y" wide><${Range} value=${s.crop.y} min=${-1} max=${1} step=${0.01} onInput=${v => set({crop: {...s.crop, y: v}})} onCommit=${commit}/><//>
    <//>
    <${Section} title="Elements" actions=${html`<span class="add-menu">
      <${Btn} small icon="text" title="Add text" onClick=${() => { const n = addLayer(c, s.id, {type: 'text', text: 'New text', size: Math.round(c.width * 0.08), enter: {preset: 'rise'}}); p.update(n); setSel({kind: 'layer', id: n.scenes.find(x => x.id === s.id).layers.at(-1).id, sceneId: s.id}); }}/>
      <${Btn} small icon="shape" title="Add shape" onClick=${() => { const n = addLayer(c, s.id, {type: 'shape', shape: 'pill', width: c.width * 0.5, height: c.width * 0.12, fill: '#ffffff', enter: {preset: 'pop'}}); p.update(n); setSel({kind: 'layer', id: n.scenes.find(x => x.id === s.id).layers.at(-1).id, sceneId: s.id}); }}/>
    </span>`}>
      <ul class="layer-list">
        ${[...s.layers].reverse().map(L => html`<li class=${L.hidden ? 'is-hidden' : ''}>
          <button class="layer-row" onClick=${() => { setSel({kind: 'layer', id: L.id, sceneId: s.id}); player.select(L.id); }}>
            <${Icon} name=${LAYER_ICON[L.type]} size=${14}/><span>${L.name || (L.type === 'text' ? L.text.replace(/\s+/g, ' ') : label(L.type))}</span>
          </button>
          <button class="icon-tiny" title=${L.hidden ? 'Show' : 'Hide'} onClick=${() => p.update(setLayer(c, L.id, {hidden: !L.hidden}))}><${Icon} name=${L.hidden ? 'eyeOff' : 'eye'} size=${14}/></button>
        </li>`)}
      </ul>
    <//>
  </div>`;
}

function LayerInspector({p, scene, L, live, commit, setSel}) {
  const c = p.comp;
  const set = (patch, done) => (done ? p.update(setLayer(c, L.id, patch)) : live(setLayer(c, L.id, patch)));
  const anim = (key, list) => {
    const a = L[key];
    const preset = a?.preset || 'none';
    return html`
      <${Field} label=${key === 'enter' ? 'Entrance' : key === 'exit' ? 'Exit' : 'Loop'}><${Select} value=${preset} options=${opt(list)} onChange=${v => set({[key]: v === 'none' ? null : {...(a || {}), preset: v}}, true)}/><//>
      ${a && key !== 'loop' && html`
        <${Field} label="Duration"><${Num} value=${a.duration} step=${0.05} min=${0.05} max=${10} unit="s" onInput=${v => set({[key]: {...a, duration: v}})} onCommit=${commit}/><//>
        <${Field} label="Delay"><${Num} value=${a.delay} step=${0.05} min=${0} unit="s" onInput=${v => set({[key]: {...a, delay: v}})} onCommit=${commit}/><//>
        <${Field} label="Easing"><${Select} value=${a.ease} options=${opt(EASINGS)} onChange=${v => set({[key]: {...a, ease: v}}, true)}/><//>`}
      ${a && key === 'loop' && html`
        <${Field} label="Amount"><${Num} value=${a.amount} step=${0.1} min=${0} max=${10} onInput=${v => set({loop: {...a, amount: v}})} onCommit=${commit}/><//>
        <${Field} label="Speed"><${Num} value=${a.speed} step=${0.1} min=${0.05} max=${20} unit="×" onInput=${v => set({loop: {...a, speed: v}})} onCommit=${commit}/><//>`}`;
  };
  return html`<div class="insp">
    <div class="insp-head"><span class="insp-kind">${label(L.type)} · ${scene.name}</span>
      <input class="insp-title" value=${L.name || (L.type === 'text' ? L.text.split('\n')[0].slice(0, 40) : label(L.type))} onChange=${e => set({name: e.target.value}, true)} aria-label="Layer name"/>
      <div class="insp-actions">
        <${Btn} small icon="up" title="Bring forward" onClick=${() => p.update(moveLayer(c, L.id, 1))}/>
        <${Btn} small icon="down" title="Send backward" onClick=${() => p.update(moveLayer(c, L.id, -1))}/>
        <${Btn} small icon="trash" title="Delete element" onClick=${() => { p.update(deleteLayer(c, L.id)); setSel({kind: 'scene', sceneId: scene.id}); }}/>
      </div>
    </div>
    ${L.type === 'text' && html`<${Section} title="Text">
      <${Field} label="Content" wide><textarea class="ta" rows="3" value=${L.text} onInput=${e => set({text: e.target.value})} onBlur=${commit}></textarea><//>
      <${Field} label="Font" wide><${Select} value=${L.font} options=${FONTS} onChange=${v => set({font: v}, true)}/><//>
      <${Field} label="Size"><${Num} value=${L.size} step=${1} min=${4} unit="px" digits=${0} onInput=${v => set({size: v})} onCommit=${commit}/><//>
      <${Field} label="Weight"><${Select} value=${String(L.weight)} options=${['300', '400', '500', '600', '700', '800', '900']} onChange=${v => set({weight: Number(v)}, true)}/><//>
      <${Field} label="Color" wide><${Color} value=${L.color} onChange=${(v, d) => set({color: v, gradient: null}, d)}/><//>
      <${Field} label="Line height"><${Num} value=${L.lineHeight} step=${0.01} min=${0.6} max=${3} onInput=${v => set({lineHeight: v})} onCommit=${commit}/><//>
      <${Field} label="Tracking"><${Num} value=${L.letterSpacing} step=${0.005} min=${-0.3} max=${2} unit="em" digits=${3} onInput=${v => set({letterSpacing: v})} onCommit=${commit}/><//>
      <${Field} label="Align"><${Select} value=${L.align} options=${opt(['left', 'center', 'right'])} onChange=${v => set({align: v}, true)}/><//>
      <${Field} label="Caps"><${Toggle} value=${L.uppercase} onChange=${v => set({uppercase: v}, true)}/><//>
      ${L.background && html`<${Field} label="Label fill" wide><${Color} value=${L.background} onChange=${(v, d) => set({background: v}, d)}/><//>`}
    <//>`}
    ${L.type === 'image' && html`<${Section} title="Image">
      <${Field} label="File" wide><${Select} value=${L.src.replace(/^asset:/, '')} options=${(p.assets || []).filter(n => /\.(png|jpe?g|webp|gif)$/i.test(n))} onChange=${v => set({src: `asset:${v}`}, true)}/><//>
      <${Field} label="Fit"><${Select} value=${L.fit} options=${opt(['cover', 'contain', 'fill'])} onChange=${v => set({fit: v}, true)}/><//>
      <${Field} label="Mask"><${Select} value=${L.mask} options=${opt(['none', 'rounded', 'circle', 'arch', 'blob'])} onChange=${v => set({mask: v}, true)}/><//>
      <${Field} label="Corner radius"><${Num} value=${L.radius} step=${1} min=${0} unit="px" digits=${0} onInput=${v => set({radius: v})} onCommit=${commit}/><//>
    <//>`}
    ${L.type === 'shape' && html`<${Section} title="Shape">
      <${Field} label="Shape"><${Select} value=${L.shape} options=${opt(['rect', 'pill', 'circle', 'ring', 'line', 'triangle', 'star', 'blob'])} onChange=${v => set({shape: v}, true)}/><//>
      <${Field} label="Radius"><${Num} value=${L.radius} step=${1} min=${0} unit="px" digits=${0} onInput=${v => set({radius: v})} onCommit=${commit}/><//>
      <${Field} label="Fill" wide><${Color} value=${L.fill} onChange=${(v, d) => set({fill: v, gradient: null}, d)}/><//>
    <//>`}
    ${L.type === 'background' && html`<${Section} title="Background">
      <${Field} label="Base color" wide><${Color} value=${L.fill} onChange=${(v, d) => set({fill: v}, d)}/><//>
      ${L.gradient && L.gradient.stops.map((st, i) => html`<${Field} label=${`Gradient ${i + 1}`} wide><${Color} value=${st[0]} onChange=${(v, d) => set({gradient: {...L.gradient, stops: L.gradient.stops.map((x, j) => (j === i ? [v, x[1]] : x))}}, d)}/><//>`)}
      <${Field} label="Motion"><${Select} value=${L.animate} options=${opt(['none', 'shift', 'rotate', 'pulse', 'aurora'])} onChange=${v => set({animate: v}, true)}/><//>
      <${Field} label="Grain"><${Range} value=${L.grain} onInput=${v => set({grain: v})} onCommit=${commit}/><//>
      <${Field} label="Vignette" wide><${Range} value=${L.vignette} onInput=${v => set({vignette: v})} onCommit=${commit}/><//>
    <//>`}
    ${L.type === 'image' && L.prompt && html`<${Section} title="Generated image">
      <${Field} label="Prompt" wide><textarea class="ta" rows="4" value=${L.prompt} onInput=${e => set({prompt: e.target.value})} onBlur=${commit}></textarea><//>
      <div class="field-wide"><${Btn} kind="secondary" small icon="image" label=${L.genPrompt === L.prompt && L.src ? 'Generated' : 'Generate image'} disabled=${L.genPrompt === L.prompt && !!L.src} onClick=${() => p.generateImages()}/></div>
    <//>`}
    ${L.type === 'ui' && html`<${Section} title="Screen">
      <${Field} label="Device"><${Select} value=${L.device} options=${opt(DEVICES)} onChange=${v => set({device: v}, true)}/><//>
      <${Field} label="Screen color"><${Color} value=${L.screen} onChange=${(v, d) => set({screen: v}, d)}/><//>
      <${Field} label="Frame color" wide><${Color} value=${L.deviceColor} onChange=${(v, d) => set({deviceColor: v}, d)}/><//>
      ${(L.device === 'browser' || L.device === 'laptop') && html`<${Field} label="Address bar" wide><input class="color-text" value=${L.url} onChange=${e => set({url: e.target.value}, true)}/><//>`}
      <p class="insp-tip">The screen content is a live app mockup. Ask Claude to change what it shows.</p>
    <//>`}
    ${L.type === 'effect' && html`<${Section} title="Effect">
      <${Field} label="Effect" wide><${Select} value=${L.effect} options=${opt(EFFECTS)} onChange=${v => set({effect: v}, true)}/><//>
      <${Field} label="Density"><${Num} value=${L.density} step=${0.1} min=${0} max=${4} onInput=${v => set({density: v})} onCommit=${commit}/><//>
      <${Field} label="Speed"><${Num} value=${L.speed} step=${0.1} min=${0} max=${10} unit="×" onInput=${v => set({speed: v})} onCommit=${commit}/><//>
      <${Field} label="Size"><${Num} value=${L.size} step=${0.1} min=${0.1} max=${10} unit="×" onInput=${v => set({size: v})} onCommit=${commit}/><//>
      <${Field} label="Variation"><${Num} value=${L.seed} step=${1} min=${0} digits=${0} onInput=${v => set({seed: v})} onCommit=${commit}/><//>
      ${(L.colors.length ? L.colors : []).map((c, i) => html`<${Field} label=${`Color ${i + 1}`} wide><${Color} value=${c} onChange=${(v, d) => set({colors: L.colors.map((x, j) => (j === i ? v : x))}, d)}/><//>`)}
    <//>`}
    ${L.type === 'cursor' && html`<${Section} title="Cursor">
      <${Field} label="Style"><${Select} value=${L.style} options=${opt(['pointer', 'hand', 'touch'])} onChange=${v => set({style: v}, true)}/><//>
      <${Field} label="Size"><${Num} value=${L.size} step=${1} min=${8} unit="px" digits=${0} onInput=${v => set({size: v})} onCommit=${commit}/><//>
      <p class="insp-tip">Taps at ${L.taps.length ? L.taps.map(t => `${t.toFixed(1)}s`).join(', ') : 'no times yet'}.</p>
    <//>`}
    ${L.type === 'code' && html`<${Section} title="Effect">
      <p class="insp-tip">A custom effect drawn by code. Ask Claude to change it, or hide it with the eye in the scene's element list.</p>
    <//>`}
    ${L.type !== 'background' && html`<${Section} title="Position">
      <${Field} label="X"><${Num} value=${L.x} step=${1} unit="X" digits=${0} onInput=${v => set({x: v})} onCommit=${commit}/><//>
      <${Field} label="Y"><${Num} value=${L.y} step=${1} unit="Y" digits=${0} onInput=${v => set({y: v})} onCommit=${commit}/><//>
      <${Field} label="Width"><${Num} value=${L.width} step=${1} min=${1} unit="W" digits=${0} onInput=${v => set({width: v})} onCommit=${commit}/><//>
      ${L.type !== 'text' && html`<${Field} label="Height"><${Num} value=${L.height} step=${1} min=${1} unit="H" digits=${0} onInput=${v => set({height: v})} onCommit=${commit}/><//>`}
      <${Field} label="Scale"><${Num} value=${L.scale} step=${0.01} min=${0} unit="×" onInput=${v => set({scale: v})} onCommit=${commit}/><//>
      <${Field} label="Rotate"><${Num} value=${L.rotate} step=${1} unit="°" digits=${1} onInput=${v => set({rotate: v})} onCommit=${commit}/><//>
      <${Field} label="Opacity" wide><${Range} value=${L.opacity} onInput=${v => set({opacity: v})} onCommit=${commit}/><//>
      <${Field} label="Blur"><${Num} value=${L.blur} step=${1} min=${0} unit="px" digits=${0} onInput=${v => set({blur: v})} onCommit=${commit}/><//>
    <//>`}
    <${Section} title="Animation">
      ${anim('enter', ENTER_PRESETS)}
      ${anim('exit', EXIT_PRESETS)}
      ${anim('loop', LOOP_PRESETS)}
      <${Field} label="Appears at"><${Num} value=${L.start} step=${0.05} min=${0} unit="s" onInput=${v => set({start: v})} onCommit=${commit}/><//>
      <${Field} label="Leaves at"><${Num} value=${L.end ?? scene.duration} step=${0.05} min=${0} unit="s" onInput=${v => set({end: v})} onCommit=${commit}/><//>
    <//>
    ${L.keyframes && html`<p class="insp-tip">This element also has custom keyframed motion from Claude. Position edits apply where no keyframes override them.</p>`}
  </div>`;
}

function AudioInspector({p, a, live, commit, setSel}) {
  const c = p.comp;
  const set = (patch, done) => (done ? p.update(setAudio(c, a.id, patch)) : live(setAudio(c, a.id, patch)));
  return html`<div class="insp">
    <div class="insp-head"><span class="insp-kind">${a.kind === 'music' ? 'Music' : a.kind === 'sfx' ? 'Sound effect' : 'Voice'}</span>
      <h2>${a.name || a.src.split('/').pop()}</h2>
      <div class="insp-actions">
        <${Btn} small icon=${a.muted ? 'mute' : 'volume'} title=${a.muted ? 'Unmute' : 'Mute'} onClick=${() => set({muted: !a.muted}, true)}/>
        <${Btn} small icon="trash" title="Remove" onClick=${() => { p.update(deleteAudio(c, a.id)); setSel(null); }}/>
      </div>
    </div>
    <${Section} title="Level">
      <${Field} label="Volume" wide><${Range} value=${a.volume} min=${0} max=${1.5} onInput=${v => set({volume: v})} onCommit=${commit}/><//>
      <${Field} label="Fade in"><${Num} value=${a.fadeIn} step=${0.1} min=${0} max=${10} unit="s" onInput=${v => set({fadeIn: v})} onCommit=${commit}/><//>
      <${Field} label="Fade out"><${Num} value=${a.fadeOut} step=${0.1} min=${0} max=${10} unit="s" onInput=${v => set({fadeOut: v})} onCommit=${commit}/><//>
    <//>
    <${Section} title="Timing">
      <${Field} label="Starts at"><${Num} value=${a.start} step=${0.05} min=${0} unit="s" onInput=${v => set({start: v})} onCommit=${commit}/><//>
      <${Field} label="Skip into file"><${Num} value=${a.offset} step=${0.05} min=${0} unit="s" onInput=${v => set({offset: v})} onCommit=${commit}/><//>
      <${Field} label="Length" hint="Empty plays to the end"><${Num} value=${a.duration} step=${0.05} min=${0.05} unit="s" onInput=${v => set({duration: v})} onCommit=${commit}/><//>
      <${Field} label="Snap to playhead"><${Btn} small label="Move here" onClick=${() => set({start: player.t}, true)}/><//>
    <//>
  </div>`;
}
