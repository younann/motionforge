// Deterministic DOM renderer: render(t) is a pure function of time.
import {ease, clamp01, sampleKeyframes} from './easing.js';
import {timeline} from './schema.js';
import {UiView, CursorView, EffectView} from './layers-extra.js';

const SPLIT_CHARS = /^(typewriter|chars-)/;
const SPLIT_WORDS = /^words-/;

function gradientCss(g, extraAngle = 0) {
  const stops = g.stops.map(([c, p]) => `${c} ${(p * 100).toFixed(1)}%`).join(', ');
  if (g.type === 'radial') return `radial-gradient(circle at 50% 40%, ${stops})`;
  if (g.type === 'conic') return `conic-gradient(from ${g.angle + extraAngle}deg at 50% 50%, ${stops})`;
  return `linear-gradient(${g.angle + extraAngle}deg, ${stops})`;
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.append(e);
  return e;
}

// Seeded grain tiles, shared.
let grainTiles = null;
function getGrainTiles() {
  if (grainTiles) return grainTiles;
  grainTiles = [];
  let seed = 1337;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let k = 0; k < 6; k++) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (rnd() * 255) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    grainTiles.push(`url(${c.toDataURL()})`);
  }
  return grainTiles;
}

// Effect produced by an enter/exit preset at eased progress e (0 hidden → 1 shown).
function enterFx(preset, e, D) {
  const f = {};
  switch (preset) {
    case 'fade': f.o = e; break;
    case 'rise': f.o = e; f.dy = (1 - e) * D; break;
    case 'drop': f.o = e; f.dy = -(1 - e) * D; break;
    case 'slide-left': f.o = e; f.dx = (1 - e) * D * 2; break;
    case 'slide-right': f.o = e; f.dx = -(1 - e) * D * 2; break;
    case 'scale': f.o = e; f.s = 0.6 + 0.4 * e; break;
    case 'pop': f.o = clamp01(e * 3); f.s = Math.max(0, e); break;
    case 'blur': f.o = e; f.b = (1 - e) * 30; f.s = 1.06 - 0.06 * e; break;
    case 'zoom-out': f.o = e; f.s = 1.6 - 0.6 * e; break;
    case 'rotate-in': f.o = e; f.r = (1 - e) * -14; f.dy = (1 - e) * D * 0.6; break;
    case 'flip': f.o = clamp01(e * 2); f.rx = (1 - e) * 90; break;
    case 'mask-up': f.iy = (1 - e) * 105; f.clip = true; break;
    case 'mask-down': f.iy = -(1 - e) * 105; f.clip = true; break;
    case 'wipe': f.inset = `0 ${((1 - e) * 100).toFixed(2)}% 0 0`; break;
    case 'tracking': f.o = e; f.ls = (1 - e) * 0.6; f.b = (1 - e) * 10; break;
    default: break;
  }
  return f;
}
function exitFx(preset, q, D) {
  const f = {};
  switch (preset) {
    case 'fade': f.o = 1 - q; break;
    case 'sink': f.o = 1 - q; f.dy = q * D; break;
    case 'lift': f.o = 1 - q; f.dy = -q * D; break;
    case 'slide-left': f.o = 1 - q; f.dx = -q * D * 2; break;
    case 'slide-right': f.o = 1 - q; f.dx = q * D * 2; break;
    case 'scale': f.o = 1 - q; f.s = 1 - 0.4 * q; break;
    case 'shrink': f.s = 1 - q; f.o = clamp01((1 - q) * 3); break;
    case 'blur': f.o = 1 - q; f.b = q * 30; break;
    case 'zoom-in': f.o = 1 - q; f.s = 1 + 0.6 * q; break;
    case 'mask-up': f.iy = -q * 105; f.clip = true; break;
    case 'mask-down': f.iy = q * 105; f.clip = true; break;
    case 'wipe': f.inset = `0 0 0 ${(q * 100).toFixed(2)}%`; break;
    default: break;
  }
  return f;
}
// Per-unit (char / word / line) effects.
function unitEnter(preset, e) {
  const p = preset.replace(/^(chars|words|lines)-/, '');
  switch (p) {
    case 'rise': return {o: clamp01(e * 1.4), dy: (1 - e) * 0.55, unit: 'em'};
    case 'drop': return {o: clamp01(e * 1.4), dy: -(1 - e) * 0.7, unit: 'em'};
    case 'pop': return {o: clamp01(e * 3), s: Math.max(0, e)};
    case 'blur': return {o: e, b: (1 - e) * 16, s: 1.15 - 0.15 * e};
    default: return {o: e};
  }
}
function unitExit(preset, q) {
  if (preset === 'chars-fall') return {o: 1 - q, dy: q * 0.8, r: q * 18, unit: 'em'};
  return {o: 1 - q};
}

class LayerView {
  constructor(L, comp, ctx) {
    this.L = L;
    this.ctx = ctx;
    this.root = el('div', `mf-layer mf-${L.type}`);
    this.root.dataset.id = L.id;
    this.inner = el('div', 'mf-inner', this.root);
    this.units = null;
    this.D = Math.min(comp.width, comp.height) * 0.09;
    this.build(comp);
  }
  build(comp) {
    const L = this.L, r = this.root, inner = this.inner;
    r.style.position = 'absolute';
    r.style.mixBlendMode = L.blend;
    if (L.shadow) r.style.filter = '';
    if (L.type === 'background') {
      r.style.left = '0'; r.style.top = '0'; r.style.width = `${comp.width}px`; r.style.height = `${comp.height}px`;
      inner.style.cssText = 'position:absolute;inset:0';
      if (L.grain > 0) {
        this.grain = el('div', 'mf-grain', r);
        this.grain.style.cssText = `position:absolute;inset:-10%;opacity:${(L.grain * 0.22).toFixed(3)};mix-blend-mode:overlay;background-size:256px 256px;pointer-events:none`;
      }
      if (L.vignette > 0) {
        const v = el('div', '', r);
        v.style.cssText = `position:absolute;inset:0;background:radial-gradient(ellipse at 50% 45%, transparent 45%, rgba(0,0,0,${(0.85 * L.vignette).toFixed(3)}) 100%);pointer-events:none`;
      }
      return;
    }
    if (L.type === 'text') {
      inner.style.cssText = `font-family:'${L.font}',sans-serif;font-weight:${L.weight};font-size:${L.size}px;line-height:${L.lineHeight};text-align:${L.align};white-space:pre-wrap;overflow-wrap:break-word;${L.italic ? 'font-style:italic;' : ''}${L.uppercase ? 'text-transform:uppercase;' : ''}color:${L.color};font-kerning:normal;font-feature-settings:'kern','liga'`;
      if (L.stroke && L.strokeWidth) inner.style.webkitTextStroke = `${L.strokeWidth}px ${L.stroke}`;
      if (L.textShadow) inner.style.textShadow = L.textShadow;
      if (L.background) {
        inner.style.background = L.background;
        inner.style.padding = `${L.padding * 0.55}px ${L.padding}px`;
        inner.style.borderRadius = `${L.radius}px`;
        inner.style.width = 'fit-content';
        inner.style.maxWidth = `${L.width}px`;
        inner.style.margin = L.align === 'center' ? '0 auto' : L.align === 'right' ? '0 0 0 auto' : '0';
      }
      r.style.width = `${L.width}px`;
      this.buildText();
      return;
    }
    if (L.type === 'image') {
      inner.style.cssText = 'position:absolute;inset:0;overflow:hidden';
      const radius = L.mask === 'circle' ? '50%' : L.mask === 'rounded' ? '7%' : L.mask === 'arch' ? '50% 50% 0 0 / 34% 34% 0 0' : L.mask === 'blob' ? '42% 58% 63% 37% / 41% 44% 56% 59%' : `${L.radius}px`;
      inner.style.borderRadius = radius;
      if (L.border) inner.style.border = L.border;
      const img = el('img', '', inner);
      img.decoding = 'sync';
      img.draggable = false;
      const url = L.src ? this.ctx.resolveAsset(L.src) : null;
      if (url) img.src = url;
      else {
        img.remove();
        const ph = el('div', '', inner);
        ph.style.cssText = `position:absolute;inset:0;display:grid;place-items:center;background:linear-gradient(135deg,#2a2a33,#18181d);color:rgba(255,255,255,.55);font:600 ${Math.max(14, L.width * 0.05)}px Inter,sans-serif;text-align:center;padding:8%`;
        ph.textContent = L.prompt ? 'Image will be generated' : 'Missing image';
      }
      if (L.tint) { const tn = el('div', '', inner); tn.style.cssText = `position:absolute;inset:0;background:${L.tint};mix-blend-mode:color;opacity:.55;pointer-events:none`; }
      if (L.crop) {
        const {x, y, w, h} = L.crop;
        img.style.cssText = `position:absolute;left:${(-x / w) * 100}%;top:${(-y / h) * 100}%;width:${100 / w}%;height:${100 / h}%;object-fit:fill;max-width:none`;
      } else {
        img.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${L.fit}`;
      }
      this.img = img;
      if (url) this.ctx.track(img);
    }
    if (L.type === 'shape') {
      inner.style.cssText = 'position:absolute;inset:0';
      const fill = L.gradient ? gradientCss(L.gradient) : L.fill;
      const s = inner.style;
      switch (L.shape) {
        case 'circle': s.background = fill; s.borderRadius = '50%'; break;
        case 'pill': s.background = fill; s.borderRadius = '9999px'; break;
        case 'ring': s.border = `${L.strokeWidth || 8}px solid ${L.stroke || L.fill}`; s.borderRadius = '50%'; break;
        case 'line': s.background = fill; s.borderRadius = `${L.radius}px`; s.transformOrigin = '0 50%'; break;
        case 'triangle': s.background = fill; s.clipPath = 'polygon(50% 0, 100% 100%, 0 100%)'; break;
        case 'star': s.background = fill; s.clipPath = 'polygon(50% 0,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)'; break;
        case 'blob': s.background = fill; s.borderRadius = '42% 58% 63% 37% / 41% 44% 56% 59%'; break;
        default: s.background = fill; s.borderRadius = `${L.radius}px`;
      }
      if (L.stroke && L.strokeWidth && L.shape !== 'ring') s.boxShadow = `inset 0 0 0 ${L.strokeWidth}px ${L.stroke}`;
      if (L.glow) {
        if (['triangle', 'star'].includes(L.shape)) r.style.filter = `drop-shadow(0 0 ${Math.max(20, L.width * 0.15)}px ${L.glow})`;
        else s.boxShadow = `${s.boxShadow ? s.boxShadow + ',' : ''}0 0 ${Math.max(24, L.width * 0.18)}px ${L.glow}`;
      }
    }
    if (L.type === 'ui') this.ui = new UiView(L, r, inner, this.ctx);
    if (L.type === 'cursor') this.cursor = new CursorView(L, r, inner);
    if (L.type === 'effect') this.effect = new EffectView(L, r, inner, this.ctx);
    if (L.type === 'code') {
      inner.style.cssText = 'position:absolute;inset:0';
      const c = el('canvas', '', inner);
      c.width = Math.round(L.width); c.height = Math.round(L.height);
      c.style.cssText = 'width:100%;height:100%;display:block';
      this.canvas = c;
      this.g = c.getContext('2d');
      try {
        // Generated code runs only inside the sandboxed stage frame.
        this.draw = new Function('params', `"use strict";${L.code}\n;return typeof draw==='function'?draw:null;`)(L.params);
      } catch (e) { this.ctx.onError?.(`Code layer "${L.name || L.id}": ${e.message}`); this.draw = null; }
    }
    if (L.type === 'image' || L.type === 'shape' || L.type === 'code') {
      r.style.width = `${L.width}px`;
      r.style.height = `${L.height}px`;
    }
    if (L.loop?.preset === 'shine') {
      this.shine = el('div', 'mf-shine', this.inner);
      this.shine.style.cssText = 'position:absolute;inset:0;pointer-events:none;mix-blend-mode:overlay;border-radius:inherit';
    }
    if (L.shadow) r.style.filter = `${r.style.filter || ''} drop-shadow(${L.shadow})`.trim();
    this.baseFilter = r.style.filter || '';
  }
  buildText() {
    const L = this.L;
    const presets = [L.enter?.preset, L.exit?.preset].filter(Boolean);
    const needChars = presets.some(p => SPLIT_CHARS.test(p) || p === 'chars-fall');
    const needWords = presets.some(p => SPLIT_WORDS.test(p) || p === 'words-fade');
    const needLines = presets.includes('lines-rise');
    const hl = new Set(L.highlightWords.map(w => w.toLowerCase()));
    const text = L.uppercase ? L.text : L.text;
    this.unitsChars = []; this.unitsWords = []; this.unitsLines = [];
    const lines = text.split('\n');
    lines.forEach((line, li) => {
      const lineEl = el('span', 'mf-line', this.inner);
      lineEl.style.display = 'block';
      let target = lineEl;
      if (needLines) {
        lineEl.style.overflow = 'hidden';
        lineEl.style.paddingBottom = '0.06em';
        target = el('span', 'mf-line-in', lineEl);
        target.style.display = 'block';
        this.unitsLines.push(target);
      }
      const words = line.split(/(\s+)/);
      for (const w of words) {
        if (!w) continue;
        if (/^\s+$/.test(w)) { target.append(document.createTextNode(w)); continue; }
        const wEl = el('span', 'mf-word', target);
        wEl.style.display = 'inline-block';
        wEl.style.whiteSpace = 'pre';
        const clean = w.toLowerCase().replace(/[^\p{L}\p{N}%$€£]/gu, '');
        if (hl.size && (hl.has(clean) || hl.has(w.toLowerCase()))) {
          wEl.style.color = L.highlight || '#ffd84d';
          wEl.dataset.hl = '1';
        }
        if (needChars) {
          for (const ch of Array.from(w)) {
            const c = el('span', 'mf-ch', wEl);
            c.style.display = 'inline-block';
            c.textContent = ch;
            this.unitsChars.push(c);
          }
        } else {
          wEl.textContent = w;
        }
        this.unitsWords.push(wEl);
      }
      if (!line.length) lineEl.innerHTML = '&#8203;';
      if (li < lines.length - 1) { /* block lines */ }
    });
  }
  // Gradient fill per word, aligned to the whole text box.
  layoutGradient() {
    const L = this.L;
    if (L.type !== 'text' || !L.gradient) return;
    const box = this.inner;
    const W = box.offsetWidth || L.width, H = box.offsetHeight || L.size;
    const css = gradientCss(L.gradient);
    const targets = this.unitsChars.length ? this.unitsChars : this.unitsWords;
    const br = box.getBoundingClientRect();
    const k = br.width / (box.offsetWidth || 1) || 1;
    for (const u of targets) {
      if (u.closest('[data-hl]')) continue;
      const ur = u.getBoundingClientRect();
      const x = (ur.left - br.left) / k, y = (ur.top - br.top) / k;
      const s = u.style;
      s.backgroundImage = css;
      s.backgroundSize = `${W}px ${H}px`;
      s.backgroundPosition = `${-x}px ${-y}px`;
      s.webkitBackgroundClip = 'text';
      s.backgroundClip = 'text';
      s.color = 'transparent';
      s.webkitTextFillColor = 'transparent';
    }
  }
  update(lt, sceneDur, comp) {
    const L = this.L, r = this.root;
    const end = L.end ?? sceneDur;
    if (L.hidden || lt < L.start || lt >= end) { r.style.visibility = 'hidden'; return; }
    r.style.visibility = 'visible';
    const kf = L.keyframes || {};
    const val = p => { const v = kf[p] ? sampleKeyframes(kf[p], lt) : undefined; return v === undefined ? L[p] : v; };
    let x = val('x'), y = val('y'), scale = val('scale'), rot = val('rotate'), op = val('opacity'), blur = val('blur');
    let sx = kf.scaleX ? sampleKeyframes(kf.scaleX, lt) : 1, sy = kf.scaleY ? sampleKeyframes(kf.scaleY, lt) : 1;
    let skew = kf.skewX ? sampleKeyframes(kf.skewX, lt) : 0;
    let bright = kf.brightness ? sampleKeyframes(kf.brightness, lt) : 1;
    const rX = kf.rotateX ? sampleKeyframes(kf.rotateX, lt) : 0, rY = kf.rotateY ? sampleKeyframes(kf.rotateY, lt) : 0;
    const progress = kf.progress ? sampleKeyframes(kf.progress, lt) : null;
    let w = kf.width ? sampleKeyframes(kf.width, lt) : L.width, h = kf.height ? sampleKeyframes(kf.height, lt) : L.height;
    let dx = 0, dy = 0, rx = 0, iy = 0, ls = kf.letterSpacing ? sampleKeyframes(kf.letterSpacing, lt) : L.letterSpacing ?? 0;
    let clip = false, inset = null;
    const local = lt - L.start;
    const apply = f => {
      if (f.o != null) op *= f.o;
      if (f.dx) dx += f.dx;
      if (f.dy) dy += f.dy;
      if (f.s != null) scale *= f.s;
      if (f.r) rot += f.r;
      if (f.rx) rx += f.rx;
      if (f.b) blur += f.b;
      if (f.iy) iy += f.iy;
      if (f.ls) ls += f.ls;
      if (f.clip) clip = true;
      if (f.inset) inset = f.inset;
    };
    const en = L.enter, ex = L.exit;
    const unitMode = p => p && (/^(chars|words|lines)-/.test(p) || p === 'typewriter');
    if (en && !unitMode(en.preset)) apply(enterFx(en.preset, ease(en.ease, (local - en.delay) / en.duration), this.D * en.distance));
    let exitQ = 0;
    if (ex) {
      const exStart = end - ex.delay - ex.duration;
      exitQ = ease(ex.ease === 'easeOutExpo' ? 'easeInCubic' : ex.ease, (lt - exStart) / ex.duration);
      if (!unitMode(ex.preset)) apply(exitFx(ex.preset, exitQ, this.D * ex.distance));
    }
    // Loops
    const lp = L.loop;
    if (lp) {
      const a = lp.amount, sp = lp.speed, T = local;
      switch (lp.preset) {
        case 'float': dy += Math.sin(T * sp * Math.PI * 2 / 3) * 14 * a; break;
        case 'pulse': scale *= 1 + 0.045 * a * Math.sin(T * sp * Math.PI * 2); break;
        case 'breathe': scale *= 1 + 0.025 * a * Math.sin(T * sp * Math.PI); op *= 0.92 + 0.08 * Math.cos(T * sp * Math.PI); break;
        case 'spin': rot += T * sp * 40 * a; break;
        case 'sway': rot += Math.sin(T * sp * Math.PI * 2 / 2.6) * 4 * a; break;
        case 'shake': dx += Math.sin(T * sp * 53) * 5 * a; dy += Math.cos(T * sp * 41) * 4 * a; break;
        case 'kenburns': scale *= 1 + 0.12 * a * clamp01(T / Math.max(1, end - L.start)); dx += T * sp * 6 * a; break;
        case 'drift': dx += T * sp * 22 * a; dy -= T * sp * 6 * a; break;
        case 'shine': if (this.shine) { const ph = ((T * sp * 0.5) % 1.6) - 0.3; this.shine.style.background = `linear-gradient(105deg, transparent ${(ph * 100 - 18).toFixed(1)}%, rgba(255,255,255,0.85) ${(ph * 100).toFixed(1)}%, transparent ${(ph * 100 + 18).toFixed(1)}%)`; } break;
        default: break;
      }
    }
    // Write styles
    const s = r.style;
    if (L.type !== 'background') {
      s.left = `${x}px`; s.top = `${y}px`;
      const anchor = L.type === 'cursor' && L.style !== 'touch' ? 'translate(-22%,-10%)' : 'translate(-50%,-50%)';
      const tilt = rx || rX || rY ? ` perspective(${Math.round(Math.max(L.width || 600, 600) * 2.4)}px)${rx || rX ? ` rotateX(${(rx + rX).toFixed(2)}deg)` : ''}${rY ? ` rotateY(${rY.toFixed(2)}deg)` : ''}` : '';
      s.transform = `${anchor} translate(${dx.toFixed(2)}px,${dy.toFixed(2)}px)${tilt} rotate(${rot.toFixed(3)}deg) scale(${(scale * sx).toFixed(4)},${(scale * sy).toFixed(4)})${skew ? ` skewX(${skew}deg)` : ''}`;
      if (kf.width && L.type !== 'text') s.width = `${w}px`;
      if (kf.height && L.type !== 'text') s.height = `${h}px`;
    }
    s.opacity = Math.max(0, Math.min(1, op)).toFixed(4);
    const filters = [];
    if (blur > 0.05) filters.push(`blur(${blur.toFixed(2)}px)`);
    if (bright !== 1) filters.push(`brightness(${bright})`);
    s.filter = `${this.baseFilter} ${filters.join(' ')}`.trim();
    s.clipPath = inset ? `inset(${inset})` : '';
    s.overflow = clip ? 'hidden' : '';
    this.inner.style.transform = iy ? `translateY(${iy.toFixed(2)}%)` : '';
    if (L.type === 'text') {
      this.inner.style.letterSpacing = `${ls.toFixed(4)}em`;
      this.updateUnits(local, lt, end, exitQ);
    }
    if (L.type === 'shape' && L.shape === 'line' && progress != null) this.inner.style.transform = `scaleX(${clamp01(progress)})`;
    if (L.type === 'background') this.updateBackground(lt, comp);
    if (this.ui) { this.ui.duration = end - L.start; this.ui.update(local, kf, sampleKeyframes); }
    if (this.cursor) this.cursor.update(local, lt);
    if (this.effect) this.effect.update(local, end - L.start);
    if (L.type === 'code' && this.draw) {
      const g = this.g;
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, this.canvas.width, this.canvas.height);
      try { this.draw(g, local, this.canvas.width, this.canvas.height, {progress: progress ?? clamp01(local / Math.max(0.01, end - L.start)), params: L.params, sceneTime: lt, duration: end - L.start}); }
      catch (e) { if (!this.errored) { this.errored = true; this.ctx.onError?.(`Code layer "${L.name || L.id}": ${e.message}`); } }
      g.restore();
    }
  }
  updateUnits(local, lt, end, exitQ) {
    const L = this.L, en = L.enter, ex = L.exit;
    const enUnits = en && (/^(chars|words|lines)-/.test(en.preset) || en.preset === 'typewriter');
    const exUnits = ex && (ex.preset === 'chars-fall' || ex.preset === 'words-fade');
    if (!enUnits && !exUnits) return;
    const listFor = p => (p.startsWith('chars') || p === 'typewriter' ? this.unitsChars : p.startsWith('lines') ? this.unitsLines : this.unitsWords);
    const all = new Set([...(enUnits ? listFor(en.preset) : []), ...(exUnits ? listFor(ex.preset) : [])]);
    const state = new Map();
    for (const u of all) state.set(u, {o: 1, dy: 0, s: 1, b: 0, r: 0, unit: 'em'});
    if (enUnits) {
      const list = listFor(en.preset);
      if (en.preset === 'typewriter') {
        const n = list.length, shown = Math.floor(clamp01((local - en.delay) / en.duration) * n + 1e-6);
        list.forEach((u, i) => { state.get(u).o = i < shown ? 1 : 0; });
      } else if (en.preset === 'lines-rise') {
        list.forEach((u, i) => { const e = ease(en.ease, (local - en.delay - i * en.stagger) / en.duration); state.get(u).ly = (1 - e) * 110; });
      } else {
        list.forEach((u, i) => {
          const e = ease(en.ease, (local - en.delay - i * en.stagger) / en.duration);
          const f = unitEnter(en.preset, e), st = state.get(u);
          if (f.o != null) st.o *= f.o; if (f.dy) st.dy += f.dy; if (f.s != null) st.s *= f.s; if (f.b) st.b += f.b;
        });
      }
    }
    if (exUnits) {
      const list = listFor(ex.preset), n = list.length;
      const exStart = end - ex.delay - ex.duration - ex.stagger * (n - 1);
      list.forEach((u, i) => {
        const q = ease('easeInCubic', (lt - exStart - i * ex.stagger) / ex.duration);
        const f = unitExit(ex.preset, q), st = state.get(u);
        st.o *= f.o; if (f.dy) st.dy += f.dy; if (f.r) st.r += f.r;
      });
    }
    for (const [u, st] of state) {
      const s = u.style;
      if (st.ly != null) { s.transform = `translateY(${st.ly.toFixed(2)}%)`; continue; }
      s.opacity = st.o.toFixed(4);
      const tr = [];
      if (st.dy) tr.push(`translateY(${st.dy.toFixed(4)}em)`);
      if (st.r) tr.push(`rotate(${st.r.toFixed(2)}deg)`);
      if (st.s !== 1) tr.push(`scale(${st.s.toFixed(4)})`);
      s.transform = tr.join(' ');
      s.filter = st.b > 0.05 ? `blur(${st.b.toFixed(2)}px)` : '';
    }
  }
  updateBackground(lt, comp) {
    const L = this.L, s = this.inner.style;
    let bg = L.fill;
    if (L.gradient) {
      const g = L.gradient;
      if (L.animate === 'aurora') {
        const blobs = g.stops.map(([c], i) => {
          const a = lt * 0.35 + i * 2.1;
          const x = 50 + Math.cos(a) * 32, y = 50 + Math.sin(a * 1.3) * 30;
          return `radial-gradient(circle at ${x.toFixed(2)}% ${y.toFixed(2)}%, ${c} 0%, transparent 55%)`;
        });
        bg = `${blobs.join(', ')}, ${L.fill}`;
      } else {
        const extra = L.animate === 'rotate' ? lt * 24 : L.animate === 'shift' ? Math.sin(lt * 0.6) * 25 : 0;
        bg = gradientCss(g, extra);
      }
    }
    s.background = bg;
    if (L.animate === 'pulse') s.filter = `brightness(${(1 + 0.12 * Math.sin(lt * Math.PI)).toFixed(3)})`;
    if (L.animate === 'shift' && L.gradient) s.backgroundSize = '100% 100%';
    if (this.grain) {
      const tiles = getGrainTiles();
      const f = Math.floor(lt * 24);
      this.grain.style.backgroundImage = tiles[f % tiles.length];
      this.grain.style.backgroundPosition = `${(f * 37) % 256}px ${(f * 91) % 256}px`;
    }
  }
}

export function createRenderer(root, {resolveAsset = () => null, onError} = {}) {
  let comp = null, scenes = [], pending = new Set();
  const ctx = {
    resolveAsset,
    onError,
    get pending() { return pending; },
    track(img) {
      if (!img.getAttribute('src') || (img.complete && img.naturalWidth)) return;
      // Settle after 8s so one bad image never blocks a render.
      const p = new Promise(res => { setTimeout(res, 8000); img.addEventListener('load', res, {once: true}); img.addEventListener('error', () => { onError?.(`Image failed to load: ${img.src.slice(0, 80)}`); res(); }, {once: true}); });
      pending.add(p); p.then(() => pending.delete(p));
    },
  };
  root.style.position = 'relative';
  root.style.overflow = 'hidden';

  function load(next) {
    comp = next;
    root.replaceChildren();
    root.style.width = `${comp.width}px`;
    root.style.height = `${comp.height}px`;
    root.style.background = comp.background;
    scenes = comp.scenes.map((s, i) => {
      const box = el('div', 'mf-scene', root);
      box.style.cssText = `position:absolute;inset:0;overflow:hidden;visibility:hidden;z-index:${i + 1};background:${s.background || comp.background}`;
      const cam = el('div', 'mf-cam', box);
      cam.style.cssText = 'position:absolute;inset:0;transform-origin:50% 50%';
      const layers = s.layers.map(L => { const v = new LayerView(L, comp, ctx); cam.append(v.root); return v; });
      return {s, box, cam, layers};
    });
    const fonts = new Set();
    comp.scenes.forEach(s => s.layers.forEach(l => { if (l.type === 'text') fonts.add(`${l.italic ? 'italic ' : ''}${l.weight} 40px '${l.font}'`); }));
    const fp = Promise.all([...fonts].map(f => document.fonts.load(f).catch(() => null))).then(() => document.fonts.ready).then(() => {
      // Measure with all scenes laid out.
      for (const sc of scenes) for (const v of sc.layers) v.layoutGradient();
    });
    pending.add(fp); fp.then(() => pending.delete(fp));
  }

  function transitionStyles(type, p) {
    const i = {}, o = {};
    switch (type) {
      case 'fade': i.opacity = p; break;
      case 'slide-left': i.transform = `translateX(${(1 - p) * 100}%)`; o.transform = `translateX(${-p * 18}%)`; break;
      case 'slide-right': i.transform = `translateX(${-(1 - p) * 100}%)`; o.transform = `translateX(${p * 18}%)`; break;
      case 'slide-up': i.transform = `translateY(${(1 - p) * 100}%)`; o.transform = `translateY(${-p * 18}%)`; break;
      case 'slide-down': i.transform = `translateY(${-(1 - p) * 100}%)`; o.transform = `translateY(${p * 18}%)`; break;
      case 'push-left': i.transform = `translateX(${(1 - p) * 100}%)`; o.transform = `translateX(${-p * 100}%)`; break;
      case 'push-up': i.transform = `translateY(${(1 - p) * 100}%)`; o.transform = `translateY(${-p * 100}%)`; break;
      case 'zoom': i.transform = `scale(${1.25 - 0.25 * p})`; i.opacity = p; o.transform = `scale(${1 + 0.15 * p})`; break;
      case 'zoom-out': i.transform = `scale(${0.82 + 0.18 * p})`; i.opacity = p; o.transform = `scale(${1 + 0.35 * p})`; o.opacity = 1 - p; break;
      case 'wipe': i.clipPath = `inset(0 ${((1 - p) * 100).toFixed(2)}% 0 0)`; break;
      case 'circle': i.clipPath = `circle(${(p * 75).toFixed(2)}% at 50% 50%)`; break;
      case 'blur': i.opacity = p; i.filter = `blur(${((1 - p) * 30).toFixed(2)}px)`; o.filter = `blur(${(p * 30).toFixed(2)}px)`; break;
      case 'flash': o.filter = `brightness(${1 + p * 8})`; i.opacity = p > 0.5 ? 1 : 0; i.filter = `brightness(${1 + Math.max(0, 1 - p) * 8})`; break;
      case 'spin': i.transform = `rotate(${(1 - p) * -90}deg) scale(${0.5 + 0.5 * p})`; i.opacity = p; break;
      default: break;
    }
    return {i, o};
  }

  function render(t) {
    if (!comp) return;
    const tl = timeline(comp);
    const active = new Map();
    for (const it of tl.items) if (t >= it.start && t < it.end) active.set(it.index, it);
    if (!active.size && tl.items.length && t >= tl.total) { const last = tl.items[tl.items.length - 1]; active.set(last.index, last); }
    const styleOf = new Map();
    for (const [idx, it] of active) {
      const s = it.scene;
      if (it.overlap > 0 && t < it.start + it.overlap && active.has(idx - 1)) {
        const p = ease(s.transition.ease, (t - it.start) / it.overlap);
        const {i, o} = transitionStyles(s.transition.type, p);
        styleOf.set(idx, i);
        styleOf.set(idx - 1, {...(styleOf.get(idx - 1) || {}), ...o});
      }
    }
    scenes.forEach((sc, idx) => {
      const it = active.get(idx);
      const b = sc.box.style;
      if (!it) {
        if (b.visibility !== 'hidden') { b.visibility = 'hidden'; for (const v of sc.layers) v.root.style.visibility = 'hidden'; }
        return;
      }
      b.visibility = 'visible';
      const st = styleOf.get(idx) || {};
      b.opacity = st.opacity ?? 1;
      b.transform = st.transform || '';
      b.clipPath = st.clipPath || '';
      b.filter = st.filter || '';
      const s = sc.s;
      const lt = s.trimStart + Math.max(0, Math.min(t, it.end - 1e-4) - it.start) * s.speed;
      const c = s.crop;
      let camT = c.zoom !== 1 || c.x || c.y ? `scale(${c.zoom}) translate(${(-c.x * 50 * (1 - 1 / c.zoom)).toFixed(3)}%, ${(-c.y * 50 * (1 - 1 / c.zoom)).toFixed(3)}%)` : '';
      const cm = s.camera;
      if (cm) {
        const z = cm.zoom ? sampleKeyframes(cm.zoom, lt) : 1, cx = cm.x ? sampleKeyframes(cm.x, lt) : 0, cy = cm.y ? sampleKeyframes(cm.y, lt) : 0, cr = cm.rotate ? sampleKeyframes(cm.rotate, lt) : 0;
        camT += ` scale(${z.toFixed(4)}) rotate(${cr.toFixed(3)}deg) translate(${(-cx).toFixed(2)}px, ${(-cy).toFixed(2)}px)`;
      }
      sc.cam.style.transform = camT;
      for (const v of sc.layers) v.update(lt, s.duration, comp);
    });
  }

  async function ready() {
    while (pending.size) await Promise.all([...pending]);
    const imgs = root.querySelectorAll('img');
    await Promise.all([...imgs].map(i => (i.complete ? (i.decode ? i.decode().catch(() => null) : null) : null)));
  }

  return {load, render, ready, get comp() { return comp; }};
}
