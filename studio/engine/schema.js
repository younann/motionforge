// Composition schema: defaults, validation and timeline math.
// Shared by the browser studio and the Node server.

export const FORMATS = {
  '9:16': {width: 1080, height: 1920},
  '1:1': {width: 1080, height: 1080},
  '16:9': {width: 1920, height: 1080},
  '4:5': {width: 1080, height: 1350},
};
export const MAX_DURATION = 30;
export const LAYER_TYPES = ['background', 'text', 'image', 'shape', 'ui', 'effect', 'cursor', 'code'];
export const EFFECTS = ['confetti', 'sparkles', 'bokeh', 'rays', 'speed-lines', 'light-leak', 'dust', 'glow-orbs', 'grid', 'waves', 'snow', 'stars', 'shockwave', 'scanlines'];
export const DEVICES = ['none', 'iphone', 'android', 'tablet', 'browser', 'laptop'];
export const TRANSITIONS = ['none', 'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'zoom', 'zoom-out', 'wipe', 'circle', 'blur', 'flash', 'push-left', 'push-up', 'spin'];
export const ENTER_PRESETS = ['none', 'fade', 'rise', 'drop', 'slide-left', 'slide-right', 'scale', 'pop', 'blur', 'zoom-out', 'rotate-in', 'flip', 'mask-up', 'mask-down', 'wipe', 'tracking', 'typewriter', 'chars-rise', 'chars-pop', 'chars-blur', 'chars-drop', 'words-rise', 'words-pop', 'words-blur', 'lines-rise'];
export const EXIT_PRESETS = ['none', 'fade', 'sink', 'lift', 'slide-left', 'slide-right', 'scale', 'shrink', 'blur', 'zoom-in', 'mask-up', 'mask-down', 'wipe', 'chars-fall', 'words-fade'];
export const LOOP_PRESETS = ['none', 'float', 'pulse', 'breathe', 'spin', 'sway', 'shake', 'kenburns', 'drift', 'shine'];
export const EASINGS = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'easeOutCubic', 'easeInCubic', 'easeInOutCubic', 'easeOutQuart', 'easeInOutQuart', 'easeOutExpo', 'easeInExpo', 'easeInOutExpo', 'easeOutBack', 'easeInBack', 'easeInOutBack', 'easeOutElastic', 'spring', 'easeOutCirc', 'easeInOutSine'];
export const ANIMATABLE = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'opacity', 'blur', 'width', 'height', 'letterSpacing', 'skewX', 'brightness', 'progress', 'rotateX', 'rotateY', 'scroll'];
export const FONTS = ['Inter', 'Montserrat', 'Playfair Display', 'Space Grotesk', 'Oswald', 'Syne', 'DM Sans', 'Bebas Neue', 'Anton', 'Archivo Black', 'DM Serif Display', 'Instrument Serif', 'Poppins', 'JetBrains Mono'];

const num = (v, d, min = -Infinity, max = Infinity) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const str = (v, d = '', max = 4000) => (typeof v === 'string' ? v.slice(0, max) : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);
const bool = (v, d = false) => (typeof v === 'boolean' ? v : d);
const color = (v, d) => (typeof v === 'string' && v.length < 80 && /^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|transparent|[a-z]+)$/i.test(v.trim()) ? v.trim() : d);

let idCounter = 0;
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function gradient(g) {
  if (!g || typeof g !== 'object') return null;
  const stops = Array.isArray(g.stops) ? g.stops.slice(0, 8).map((s, i, a) => {
    if (Array.isArray(s)) return [color(s[0], '#000'), num(s[1], i / Math.max(1, a.length - 1), 0, 1)];
    if (typeof s === 'string') return [color(s, '#000'), i / Math.max(1, a.length - 1)];
    return [color(s?.color, '#000'), num(s?.pos, i / Math.max(1, a.length - 1), 0, 1)];
  }) : [];
  if (stops.length < 2) return null;
  return {type: pick(g.type, ['linear', 'radial', 'conic'], 'linear'), angle: num(g.angle, 135), stops};
}

function anim(a, list, isLoop = false) {
  if (!a) return null;
  if (typeof a === 'string') a = {preset: a};
  if (typeof a !== 'object') return null;
  const preset = pick(a.preset, list, 'none');
  if (preset === 'none') return null;
  const out = {preset};
  if (isLoop) {
    out.amount = num(a.amount, 1, 0, 10);
    out.speed = num(a.speed, 1, 0.01, 20);
  } else {
    out.duration = num(a.duration, 0.6, 0.05, 10);
    out.delay = num(a.delay, 0, 0, 30);
    out.ease = pick(a.ease, EASINGS, preset.startsWith('chars') || preset.startsWith('words') ? 'easeOutCubic' : 'easeOutExpo');
    out.stagger = num(a.stagger, preset.startsWith('chars') ? 0.03 : 0.08, 0, 2);
    out.distance = num(a.distance, 1, 0, 10);
  }
  return out;
}

function keyframes(k) {
  if (!k || typeof k !== 'object') return null;
  const out = {};
  for (const prop of Object.keys(k)) {
    if (!ANIMATABLE.includes(prop) || !Array.isArray(k[prop])) continue;
    const list = k[prop].slice(0, 64).map(f => {
      if (Array.isArray(f)) return {t: num(f[0], 0, 0, 60), v: num(f[1], 0), ease: pick(f[2], EASINGS, 'easeInOutCubic')};
      return {t: num(f?.t, 0, 0, 60), v: num(f?.v ?? f?.value, 0), ease: pick(f?.ease, EASINGS, 'easeInOutCubic')};
    }).sort((a, b) => a.t - b.t);
    if (list.length) out[prop] = list;
  }
  return Object.keys(out).length ? out : null;
}

function layer(l, comp, sceneDur) {
  if (!l || typeof l !== 'object') return null;
  const type = pick(l.type, LAYER_TYPES, null);
  if (!type) return null;
  const W = comp.width, H = comp.height;
  const base = {
    id: str(l.id, '', 80) || uid('l'),
    type,
    name: str(l.name, '', 80),
    x: num(l.x, W / 2, -W * 3, W * 4),
    y: num(l.y, H / 2, -H * 3, H * 4),
    width: l.width == null ? null : num(l.width, null, 1, W * 6),
    height: l.height == null ? null : num(l.height, null, 1, H * 6),
    rotate: num(l.rotate, 0),
    scale: num(l.scale, 1, 0, 50),
    opacity: num(l.opacity, 1, 0, 1),
    blur: num(l.blur, 0, 0, 200),
    start: num(l.start, 0, 0, 60),
    end: l.end == null ? null : num(l.end, null, 0, 60),
    enter: anim(l.enter, ENTER_PRESETS),
    exit: anim(l.exit, EXIT_PRESETS),
    loop: anim(l.loop, LOOP_PRESETS, true),
    keyframes: keyframes(l.keyframes),
    blend: pick(l.blend, ['normal', 'screen', 'multiply', 'overlay', 'lighten', 'soft-light', 'difference', 'color-dodge'], 'normal'),
    shadow: str(l.shadow, '', 200) || null,
    hidden: bool(l.hidden),
    locked: bool(l.locked),
  };
  if (base.end != null && base.end <= base.start) base.end = null;
  if (type === 'background') {
    Object.assign(base, {
      fill: color(l.fill, '#0b0b10'), gradient: gradient(l.gradient),
      animate: pick(l.animate, ['none', 'shift', 'rotate', 'pulse', 'aurora'], 'none'),
      grain: num(l.grain, 0, 0, 1), vignette: num(l.vignette, 0, 0, 1),
      x: W / 2, y: H / 2, width: W, height: H,
    });
  } else if (type === 'text') {
    Object.assign(base, {
      text: str(l.text, 'Text', 600),
      font: pick(l.font, FONTS, 'Inter'),
      weight: num(l.weight, 700, 100, 900),
      size: num(l.size, 96, 4, 2000),
      color: color(l.color, '#ffffff'),
      gradient: gradient(l.gradient),
      align: pick(l.align, ['left', 'center', 'right'], 'center'),
      lineHeight: num(l.lineHeight, 1.05, 0.6, 3),
      letterSpacing: num(l.letterSpacing, 0, -0.3, 2),
      uppercase: bool(l.uppercase),
      italic: bool(l.italic),
      stroke: color(l.stroke, null), strokeWidth: num(l.strokeWidth, 0, 0, 40),
      background: color(l.background, null), padding: num(l.padding, 0, 0, 400), radius: num(l.radius, 0, 0, 2000),
      textShadow: str(l.textShadow, '', 200) || null,
      highlight: color(l.highlight, null),
      highlightWords: Array.isArray(l.highlightWords) ? l.highlightWords.slice(0, 20).map(w => str(w, '', 60)) : [],
    });
    if (base.width == null) base.width = Math.round(W * 0.86);
  } else if (type === 'image') {
    const crop = l.crop && typeof l.crop === 'object' ? {x: num(l.crop.x, 0, 0, 1), y: num(l.crop.y, 0, 0, 1), w: num(l.crop.w, 1, 0.01, 1), h: num(l.crop.h, 1, 0.01, 1)} : null;
    Object.assign(base, {
      src: str(l.src, '', 300),
      fit: pick(l.fit, ['cover', 'contain', 'fill'], 'cover'),
      radius: num(l.radius, 0, 0, 4000),
      border: str(l.border, '', 120) || null,
      crop,
      mask: pick(l.mask, ['none', 'circle', 'rounded', 'arch', 'blob'], 'none'),
      prompt: str(l.prompt, '', 1200) || null,
      seed: Number.isInteger(l.seed) ? l.seed : null,
      genPrompt: str(l.genPrompt, '', 1200) || null,
      tint: color(l.tint, null),
    });
    if (base.width == null) base.width = Math.round(W * 0.7);
    if (base.height == null) base.height = Math.round(base.width);
  } else if (type === 'shape') {
    Object.assign(base, {
      shape: pick(l.shape, ['rect', 'circle', 'ring', 'line', 'triangle', 'star', 'blob', 'pill'], 'rect'),
      fill: color(l.fill, '#ffffff'), gradient: gradient(l.gradient),
      radius: num(l.radius, 0, 0, 4000),
      stroke: color(l.stroke, null), strokeWidth: num(l.strokeWidth, 0, 0, 200),
      glow: color(l.glow, null),
    });
    if (base.width == null) base.width = 200;
    if (base.height == null) base.height = base.shape === 'line' ? 6 : base.width;
  } else if (type === 'ui') {
    const vp = l.viewport && typeof l.viewport === 'object' ? l.viewport : {};
    const device = pick(l.device, DEVICES, 'none');
    const defVp = device === 'browser' || device === 'laptop' ? {width: 1280, height: 800} : device === 'tablet' ? {width: 820, height: 1180} : {width: 390, height: 844};
    Object.assign(base, {
      html: sanitizeHtml(str(Array.isArray(l.html) ? l.html.join('') : l.html, '', 40000)),
      css: str(Array.isArray(l.css) ? l.css.join('\n') : l.css, '', 30000).replace(/@import[^;]*;?/gi, '').replace(/url\(\s*['"]?(?!asset:|data:)[^)]*\)/gi, 'none'),
      device,
      viewport: {width: num(vp.width, defVp.width, 120, 3000), height: num(vp.height, defVp.height, 120, 4000)},
      screen: color(l.screen, '#ffffff'),
      url: str(l.url, '', 120),
      deviceColor: color(l.deviceColor, '#1b1b1f'),
    });
    if (base.width == null) base.width = Math.round(W * (device === 'browser' || device === 'laptop' ? 0.86 : 0.62));
  } else if (type === 'effect') {
    Object.assign(base, {
      effect: pick(l.effect, EFFECTS, 'sparkles'),
      colors: Array.isArray(l.colors) ? l.colors.slice(0, 6).map(c => color(c, '#ffffff')) : [],
      density: num(l.density, 1, 0, 4),
      speed: num(l.speed, 1, 0, 10),
      size: num(l.size, 1, 0.1, 10),
      seed: num(l.seed, 1, 0, 1e6),
    });
    if (base.width == null) base.width = W;
    if (base.height == null) base.height = H;
  } else if (type === 'cursor') {
    Object.assign(base, {
      style: pick(l.style, ['pointer', 'hand', 'touch'], 'pointer'),
      color: color(l.color, '#ffffff'),
      size: num(l.size, 64, 8, 400),
      taps: Array.isArray(l.taps) ? l.taps.slice(0, 40).map(t => num(t, 0, 0, 60)).sort((a, b) => a - b) : [],
    });
  } else if (type === 'code') {
    Object.assign(base, {code: str(l.code, '', 20000), params: l.params && typeof l.params === 'object' ? JSON.parse(JSON.stringify(l.params)) : {}});
    if (base.width == null) base.width = W;
    if (base.height == null) base.height = H;
  }
  return base;
}

function cameraKeys(cam) {
  if (!cam || typeof cam !== 'object') return null;
  const out = {};
  for (const k of ['zoom', 'x', 'y', 'rotate']) {
    if (!Array.isArray(cam[k])) continue;
    const list = cam[k].slice(0, 32).map(f => (Array.isArray(f) ? {t: num(f[0], 0, 0, 60), v: num(f[1], k === 'zoom' ? 1 : 0), ease: pick(f[2], EASINGS, 'easeInOutCubic')} : {t: num(f?.t, 0, 0, 60), v: num(f?.v, k === 'zoom' ? 1 : 0), ease: pick(f?.ease, EASINGS, 'easeInOutCubic')})).sort((a, b) => a.t - b.t);
    if (list.length) out[k] = list;
  }
  return Object.keys(out).length ? out : null;
}

// Strip scripts, event handlers and remote URLs from UI markup.
export function sanitizeHtml(h) {
  return h
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta|base)[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href|action|poster)\s*=\s*("|')\s*(javascript:|https?:|\/\/)[^"']*\2/gi, '$1=$2#$2');
}

function scene(s, comp, i) {
  if (!s || typeof s !== 'object') return null;
  const duration = num(s.duration, 3, 0.2, MAX_DURATION);
  const out = {
    id: str(s.id, '', 80) || uid('s'),
    name: str(s.name, `Scene ${i + 1}`, 80),
    duration,
    trimStart: num(s.trimStart, 0, 0, duration - 0.1),
    trimEnd: num(s.trimEnd, 0, 0, duration - 0.1),
    transition: (() => {
      const t = typeof s.transition === 'string' ? {type: s.transition} : s.transition || {};
      return {type: pick(t.type, TRANSITIONS, 'none'), duration: num(t.duration, 0.5, 0.05, 3), ease: pick(t.ease, EASINGS, 'easeInOutCubic')};
    })(),
    crop: {zoom: num(s.crop?.zoom, 1, 1, 8), x: num(s.crop?.x, 0, -1, 1), y: num(s.crop?.y, 0, -1, 1)},
    speed: num(s.speed, 1, 0.25, 4),
    camera: cameraKeys(s.camera),
    background: color(s.background, null),
    layers: [],
    notes: str(s.notes, '', 1000),
  };
  if (out.trimStart + out.trimEnd > duration - 0.1) out.trimEnd = Math.max(0, duration - 0.1 - out.trimStart);
  if (i === 0) out.transition.type = 'none';
  out.layers = (Array.isArray(s.layers) ? s.layers.slice(0, 80) : []).map(l => layer(l, comp, duration)).filter(Boolean);
  return out;
}

function audioClip(a) {
  if (!a || typeof a !== 'object') return null;
  const src = str(a.src, '', 300);
  if (!/^(lib:(music|sfx)\/[a-z0-9-]+|asset:[^/\\]+)$/i.test(src)) return null;
  return {
    id: str(a.id, '', 80) || uid('a'),
    kind: pick(a.kind, ['music', 'sfx', 'voice'], src.startsWith('lib:sfx') ? 'sfx' : 'music'),
    src,
    name: str(a.name, '', 80),
    start: num(a.start, 0, 0, MAX_DURATION),
    offset: num(a.offset, 0, 0, 600),
    duration: a.duration == null ? null : num(a.duration, null, 0.05, 600),
    volume: num(a.volume, 1, 0, 2),
    fadeIn: num(a.fadeIn, 0, 0, 10),
    fadeOut: num(a.fadeOut, 0, 0, 10),
    muted: bool(a.muted),
  };
}

export function normalizeComp(input = {}) {
  const c = input && typeof input === 'object' ? input : {};
  let width = num(c.width, 1080, 240, 3840), height = num(c.height, 1920, 240, 3840);
  if (c.format && FORMATS[c.format]) ({width, height} = FORMATS[c.format]);
  const comp = {
    version: 1,
    title: str(c.title, 'Untitled', 120),
    width: Math.round(width / 2) * 2,
    height: Math.round(height / 2) * 2,
    fps: pick(Number(c.fps), [24, 25, 30, 50, 60], 30),
    background: color(c.background, '#000000'),
    scenes: [],
    audio: [],
    style: c.style && typeof c.style === 'object' ? {palette: Array.isArray(c.style.palette) ? c.style.palette.slice(0, 8).map(p => color(p, '#fff')) : [], fonts: Array.isArray(c.style.fonts) ? c.style.fonts.filter(f => FONTS.includes(f)).slice(0, 4) : []} : {palette: [], fonts: []},
  };
  comp.scenes = (Array.isArray(c.scenes) ? c.scenes.slice(0, 40) : []).map((s, i) => scene(s, comp, i)).filter(Boolean);
  const seen = new Set();
  for (const s of comp.scenes) {
    if (seen.has(s.id)) s.id = uid('s');
    seen.add(s.id);
    for (const l of s.layers) { if (seen.has(l.id)) l.id = uid('l'); seen.add(l.id); }
  }
  comp.audio = (Array.isArray(c.audio) ? c.audio.slice(0, 60) : []).map(audioClip).filter(Boolean);
  return comp;
}

export function validateComp(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return ['comp.json must be a JSON object'];
  if (!Array.isArray(input.scenes) || !input.scenes.length) errors.push('comp.scenes must be a non-empty array');
  (input.scenes || []).forEach((s, i) => {
    if (!Array.isArray(s?.layers)) errors.push(`scenes[${i}].layers must be an array`);
    (s?.layers || []).forEach((l, j) => {
      if (!LAYER_TYPES.includes(l?.type)) errors.push(`scenes[${i}].layers[${j}].type "${l?.type}" is not one of ${LAYER_TYPES.join(', ')}`);
      if (l?.type === 'image' && !/^asset:/.test(l.src || '') && !(typeof l.prompt === 'string' && l.prompt.trim())) errors.push(`scenes[${i}].layers[${j}] image needs src "asset:<filename>" or a "prompt" to generate it`);
      if (l?.type === 'effect' && l.effect && !EFFECTS.includes(l.effect)) errors.push(`scenes[${i}].layers[${j}].effect "${l.effect}" is unknown`);
      if (l?.type === 'ui' && !String(Array.isArray(l.html) ? l.html.join('') : l.html || '').trim()) errors.push(`scenes[${i}].layers[${j}] ui layer needs html`);
      for (const k of ['enter', 'exit']) {
        const p = typeof l?.[k] === 'string' ? l[k] : l?.[k]?.preset;
        const list = k === 'enter' ? ENTER_PRESETS : EXIT_PRESETS;
        if (p && !list.includes(p)) errors.push(`scenes[${i}].layers[${j}].${k} preset "${p}" is unknown`);
      }
    });
  });
  (input.audio || []).forEach((a, i) => { if (!audioClip(a)) errors.push(`audio[${i}] is invalid (src must be lib:music/<id>, lib:sfx/<id> or asset:<file>)`); });
  const norm = normalizeComp(input);
  const total = timeline(norm).total;
  if (total > MAX_DURATION + 0.01) errors.push(`total duration ${total.toFixed(2)}s exceeds ${MAX_DURATION}s`);
  return errors;
}

export const playable = s => Math.max(0.1, (s.duration - s.trimStart - s.trimEnd) / (s.speed || 1));

// Scene start times. Transitions overlap the previous scene's tail.
export function timeline(comp) {
  const items = [];
  let cursor = 0;
  comp.scenes.forEach((s, i) => {
    const len = playable(s);
    let overlap = 0;
    if (i > 0 && s.transition.type !== 'none') overlap = Math.min(s.transition.duration, len * 0.9, items[i - 1].length * 0.9);
    const start = Math.max(0, cursor - overlap);
    items.push({scene: s, index: i, start, length: len, end: start + len, overlap});
    cursor = start + len;
  });
  return {items, total: cursor};
}

export function sceneAt(comp, t) {
  return timeline(comp).items.filter(it => t >= it.start && t < it.end + 1e-6);
}

export function emptyComp(format = '9:16', title = 'Untitled') {
  return normalizeComp({format, title, scenes: [], audio: []});
}
