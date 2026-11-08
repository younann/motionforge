import {html, useState, useRef, useEffect} from '../vendor/preact-htm.js';

const P = {
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z',
  back: 'M6 5h2v14H6zM19 5v14L9 12z',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'm15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  split: 'M12 3v18M7 8l-4 4 4 4M17 8l4 4-4 4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  plus: 'M12 5v14M5 12h14',
  attach: 'm21 11-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.2a1.8 1.8 0 0 1-2.6-2.6l8.5-8.5',
  send: 'M5 12h14M13 6l6 6-6 6',
  stop: 'M7 7h10v10H7z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  music: 'M9 18V6l11-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6z',
  image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9.5a1.5 1.5 0 1 0 0-.01',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  shape: 'M12 3l9 16H3z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 6.1A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.6 6.6C3.9 8.3 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 4.4-1.1',
  up: 'm6 15 6-6 6 6', down: 'm6 9 6 6 6-6',
  close: 'M6 6l12 12M18 6 6 18',
  chat: 'M4 5h16v11H9l-5 4z',
  layers: 'm12 3 9 5-9 5-9-5zM3 13l9 5 9-5',
  home: 'M4 11 12 4l8 7v9h-5v-6H9v6H4z',
  loop: 'M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4',
  mute: 'M11 5 6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6',
  volume: 'M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6M11 8v6',
  zoomOut: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6',
  restore: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  sliders: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  wand: 'M15 4V2M15 10V8M11 6h2M17 6h2M4 20 14 10M18 13l1 1M10 4 9 3',
};
export const Icon = ({name, size = 18, stroke = 1.7}) => html`
  <svg class="icon" width=${size} height=${size} viewBox="0 0 24 24" fill=${['play', 'pause', 'back', 'stop'].includes(name) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width=${stroke} stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${P[name] || ''}/></svg>`;

export const Btn = ({icon, label, onClick, kind = 'ghost', disabled, title, active, small, type = 'button', children}) => html`
  <button type=${type} class=${`btn btn-${kind}${small ? ' btn-sm' : ''}${active ? ' is-active' : ''}${!label && !children ? ' btn-icon' : ''}`} onClick=${onClick} disabled=${disabled} title=${title || label} aria-label=${label ? undefined : title}>
    ${icon && html`<${Icon} name=${icon} size=${small ? 15 : 17}/>`}${label && html`<span>${label}</span>`}${children}
  </button>`;

export const Field = ({label, children, hint, wide}) => html`
  <label class=${`field${wide ? ' field-wide' : ''}`}><span class="field-label">${label}</span>${children}${hint && html`<span class="field-hint">${hint}</span>`}</label>`;

export function Num({value, onInput, onCommit, step = 1, min, max, unit, digits = 2}) {
  const [draft, setDraft] = useState(null);
  const shown = draft ?? (value == null ? '' : String(+Number(value).toFixed(digits)));
  const ref = useRef(null);
  const scrub = e => {
    if (e.button !== 0) return;
    const x0 = e.clientX, v0 = Number(value) || 0;
    let moved = false;
    const move = ev => {
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 2) moved = true;
      if (!moved) return;
      let v = v0 + Math.round(dx / 3) * step * (ev.shiftKey ? 10 : 1);
      if (min != null) v = Math.max(min, v); if (max != null) v = Math.min(max, v);
      onInput(+v.toFixed(4));
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); if (moved) onCommit?.(); else ref.current?.focus(); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };
  const commit = () => {
    if (draft == null) return;
    let v = Number(draft);
    setDraft(null);
    if (!Number.isFinite(v)) return;
    if (min != null) v = Math.max(min, v); if (max != null) v = Math.min(max, v);
    onInput(v); onCommit?.();
  };
  return html`<div class="num">
    <span class="num-scrub" onPointerDown=${scrub} title="Drag to adjust">${unit || '↔'}</span>
    <input ref=${ref} inputmode="decimal" value=${shown} onInput=${e => setDraft(e.target.value)} onBlur=${commit} onKeyDown=${e => { if (e.key === 'Enter') { commit(); e.target.blur(); } if (e.key === 'Escape') { setDraft(null); e.target.blur(); } }}/>
  </div>`;
}

export const Select = ({value, options, onChange}) => html`
  <div class="select"><select value=${value} onChange=${e => onChange(e.target.value)}>
    ${options.map(o => (typeof o === 'string' ? html`<option value=${o}>${o}</option>` : html`<option value=${o.value}>${o.label}</option>`))}
  </select><${Icon} name="down" size=${14}/></div>`;

export function Color({value, onChange}) {
  const hex = /^#[0-9a-f]{6}$/i.test(value || '') ? value : /^#[0-9a-f]{3}$/i.test(value || '') ? `#${value.slice(1).split('').map(c => c + c).join('')}` : '#ffffff';
  return html`<div class="color">
    <input type="color" value=${hex} onInput=${e => onChange(e.target.value, false)} onChange=${e => onChange(e.target.value, true)}/>
    <input class="color-text" value=${value || ''} onChange=${e => onChange(e.target.value, true)} spellcheck="false"/>
  </div>`;
}

export const Range = ({value, min = 0, max = 1, step = 0.01, onInput, onCommit}) => html`
  <input class="range" type="range" min=${min} max=${max} step=${step} value=${value} onInput=${e => onInput(Number(e.target.value))} onChange=${() => onCommit?.()} style=${`--p:${((value - min) / (max - min)) * 100}%`}/>`;

export const Toggle = ({value, onChange, label}) => html`
  <button type="button" class=${`toggle${value ? ' on' : ''}`} role="switch" aria-checked=${value} onClick=${() => onChange(!value)}><i></i>${label && html`<span>${label}</span>`}</button>`;

export const Seg = ({value, options, onChange, size}) => html`
  <div class=${`seg${size ? ` seg-${size}` : ''}`} role="radiogroup">${options.map(o => {
    const v = typeof o === 'string' ? o : o.value, l = typeof o === 'string' ? o : o.label;
    return html`<button type="button" role="radio" aria-checked=${value === v} class=${value === v ? 'on' : ''} disabled=${o.disabled} title=${o.title || ''} onClick=${() => onChange(v)}>${l}</button>`;
  })}</div>`;

export function Modal({onClose, children, title, width = 460}) {
  useEffect(() => { const k = e => e.key === 'Escape' && onClose(); addEventListener('keydown', k); return () => removeEventListener('keydown', k); }, []);
  return html`<div class="modal-back" onClick=${e => e.target === e.currentTarget && onClose()}>
    <div class="modal" style=${`width:min(${width}px, calc(100vw - 32px))`} role="dialog" aria-label=${title}>
      <div class="modal-head"><h2>${title}</h2><${Btn} icon="close" title="Close" onClick=${onClose}/></div>
      ${children}
    </div></div>`;
}

export const fmtTime = (t, fps = 30) => {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60), s = Math.floor(t % 60), f = Math.floor((t % 1) * fps + 1e-6);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
};
export const fmtSec = t => `${(+t).toFixed(1)}s`;
export const ago = iso => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
