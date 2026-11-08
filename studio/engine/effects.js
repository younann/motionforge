// Procedural overlay effects. Every frame is a pure function of time.

export const EFFECT_NAMES = ['confetti', 'sparkles', 'bokeh', 'rays', 'speed-lines', 'light-leak', 'dust', 'glow-orbs', 'grid', 'waves', 'snow', 'stars', 'shockwave', 'scanlines'];

const TAU = Math.PI * 2;
const MAX_PARTICLES = 400;

const DEFAULTS = {
  confetti: ['#FF4D6D', '#FFC43D', '#3DDC97', '#4CC9F0', '#7B61FF', '#FFFFFF'],
  sparkles: ['#FFFFFF', '#FFF1C9', '#FFD57E'],
  bokeh: ['#FFC48C', '#FF8FC0', '#9CC8FF', '#FFFFFF'],
  rays: ['#FFF3DA', '#FFE2B5'],
  'speed-lines': ['#FFFFFF', '#D5E8FF'],
  'light-leak': ['#FF5A2E', '#FF9A3D', '#FF3D78', '#FFD36B'],
  dust: ['#FFF3DE', '#FFFFFF'],
  'glow-orbs': ['#7B61FF', '#00C8FF', '#FF4FD8', '#2EF0B0'],
  grid: ['#FF3CAC', '#7B61FF'],
  waves: ['#7B61FF', '#00C2FF', '#FF5FA2', '#FFB86B'],
  snow: ['#FFFFFF'],
  stars: ['#FFFFFF', '#D8E6FF', '#FFEDD2'],
  shockwave: ['#9BE6FF', '#FFFFFF'],
  scanlines: ['#FFFFFF'],
};

// Small math helpers
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fract = (x) => x - Math.floor(x);
const mod = (x, m) => ((x % m) + m) % m;
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// Seeded hash in [0,1)
function makeHash(seed) {
  const s = seed * 7.13;
  return (i, k = 0) => {
    const x = Math.sin((i + s) * 127.1 + k * 311.7 + 17.17) * 43758.5453;
    return x - Math.floor(x);
  };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Color parsing via canvas normalization
let parseCtx = null;
const colorCache = new Map();
function parseColor(c) {
  let v = colorCache.get(c);
  if (v) return v;
  if (!parseCtx) parseCtx = makeCanvas(1, 1).getContext('2d');
  parseCtx.fillStyle = '#ffffff';
  parseCtx.fillStyle = c;
  const s = String(parseCtx.fillStyle);
  if (s[0] === '#') {
    v = [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 1];
  } else {
    const m = s.match(/[\d.]+/g) || ['255', '255', '255', '1'];
    v = [+m[0], +m[1], +m[2], m[3] !== undefined ? +m[3] : 1];
  }
  colorCache.set(c, v);
  return v;
}
function rgba(c, a) {
  const p = parseColor(c);
  return `rgba(${p[0]},${p[1]},${p[2]},${clamp(a * p[3], 0, 1).toFixed(4)})`;
}
function mixColor(c1, c2, f) {
  const a = parseColor(c1), b = parseColor(c2);
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

// Tinted sprite cache (output independent of cache state)
const sprites = new Map();
const SPRITE_PROFILES = {
  soft: { size: 128, f: (s) => Math.exp(-s * s * 5.5) },
  glow: { size: 128, f: (s) => Math.exp(-s * s * 9) * 0.75 + Math.exp(-s * s * 60) * 0.25 + 0.0 },
  dot: { size: 32, f: (s) => smooth(1, 0.55, s) },
  flake: { size: 48, f: (s) => smooth(1, 0.3, s) * 0.85 + Math.exp(-s * s * 12) * 0.15 },
  bokeh: { size: 256, f: (s) => (s > 1 ? 0 : (0.32 + 0.12 * s * s + 0.42 * smooth(0.78, 0.95, s)) * smooth(1, 0.95, s)) },
};
function sprite(kind, color) {
  const key = kind + '|' + color;
  let c = sprites.get(key);
  if (c) return c;
  const prof = SPRITE_PROFILES[kind];
  const n = prof.size;
  c = makeCanvas(n, n);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
  for (let k = 0; k <= 24; k++) {
    const s = k / 24;
    grad.addColorStop(s, rgba(color, clamp(prof.f(s), 0, 1)));
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, n, n);
  sprites.set(key, c);
  return c;
}
function blit(ctx, img, x, y, r, a) {
  if (a <= 0.002 || r <= 0) return;
  ctx.globalAlpha = a > 1 ? 1 : a;
  ctx.drawImage(img, x - r, y - r, r * 2, r * 2);
}

// Reusable offscreen layers, cleared before each use
const layers = new Map();
function layer(key, w, h) {
  let c = layers.get(key);
  if (!c || c.width !== w || c.height !== h) {
    c = makeCanvas(w, h);
    layers.set(key, c);
  }
  const g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, w, h);
  return [c, g];
}
function composite(ctx, c, w, h, op, alpha) {
  ctx.globalCompositeOperation = op;
  ctx.globalAlpha = alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, w, h);
}

const GLINTS = Array.from({ length: 9 }, (_, k) => `rgba(255,255,255,${(0.35 * k / 8).toFixed(3)})`);

// confetti: burst with drag, gravity, flutter and flip, plus a gentle trickle
function confetti(ctx, t, w, h, o, H) {
  const { S, cols } = o;
  const T = t * o.speed;
  const n = Math.min(MAX_PARTICLES, Math.round(190 * o.density));
  const nBurst = Math.round(n * 0.72);
  const base = ctx.getTransform();
  const ox = w * 0.5, oy = h * 0.5;
  ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const k = 2.6 + H(i, 3) * 1.6;
    const vt = (170 + H(i, 4) * 170) * S;
    let x, y, tau;
    if (i < nBurst) {
      tau = T - H(i, 0) * 0.07;
      if (tau < 0) continue;
      const a = -Math.PI / 2 + (H(i, 1) - 0.5) * 2.7;
      const sp = (700 + Math.pow(H(i, 2), 0.6) * 2400) * S;
      const e = 1 - Math.exp(-k * tau);
      x = ox + (Math.cos(a) * sp / k) * e;
      y = oy + vt * tau + ((Math.sin(a) * sp - vt) / k) * e;
    } else {
      const per = (h + 160 * S) / vt;
      const t0 = 0.35 + H(i, 0) * per * 0.8;
      if (T < t0) continue;
      tau = mod(T - t0, per);
      x = H(i, 1) * w;
      y = -60 * S + vt * tau;
    }
    const settle = 1 - Math.exp(-1.4 * tau);
    x += Math.sin(tau * (1.8 + H(i, 5) * 2.6) + H(i, 6) * TAU) * (22 + H(i, 7) * 46) * S * settle;
    if (y > h + 40 * S || y < -400 * S || x < -60 * S || x > w + 60 * S) continue;
    const sz = (15 + H(i, 8) * 15) * S * o.size * Math.min(1, tau / 0.05 + 0.3);
    const rot = H(i, 9) * TAU + (H(i, 10) - 0.5) * 7 * tau;
    let flip = Math.cos(tau * (3 + H(i, 11) * 7) + H(i, 12) * TAU);
    flip = flip >= 0 ? Math.max(0.07, flip) : Math.min(-0.07, flip);
    const col = cols[Math.floor(H(i, 13) * cols.length) % cols.length];
    const shape = H(i, 14);
    const cr = Math.cos(rot), sr = Math.sin(rot);
    ctx.setTransform(base.a, base.b, base.c, base.d, base.e, base.f);
    ctx.transform(cr * flip, sr * flip, -sr, cr, x, y);
    // base + shading passes
    const glint = flip > 0 ? Math.round(Math.pow(flip, 10) * 8) : -1;
    const passes = glint === 0 ? 1 : 2;
    for (let pass = 0; pass < passes; pass++) {
      const style = pass === 0 ? col : glint < 0 ? 'rgba(0,0,0,0.28)' : GLINTS[glint];
      if (shape < 0.52) {
        ctx.fillStyle = style;
        ctx.fillRect(-sz * 0.5, -sz * 0.3, sz, sz * 0.6);
      } else if (shape < 0.78) {
        ctx.fillStyle = style;
        ctx.beginPath();
        ctx.arc(0, 0, sz * 0.36, 0, TAU);
        ctx.fill();
      } else {
        const L = sz * 0.75, A = sz * 0.55;
        ctx.strokeStyle = style;
        ctx.lineWidth = sz * 0.24;
        ctx.beginPath();
        ctx.moveTo(-L, 0);
        ctx.quadraticCurveTo(-L / 2, -A, 0, 0);
        ctx.quadraticCurveTo(L / 2, A, L, 0);
        ctx.stroke();
      }
    }
  }
  ctx.setTransform(base.a, base.b, base.c, base.d, base.e, base.f);
}

function starPath(ctx, x, y, R, rot, pinch) {
  const k = R * pinch;
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (px, py) => [x + px * c - py * s, y + px * s + py * c];
  const p0 = P(0, -R), p1 = P(R, 0), p2 = P(0, R), p3 = P(-R, 0);
  const q0 = P(k, -k), q1 = P(k, k), q2 = P(-k, k), q3 = P(-k, -k);
  ctx.beginPath();
  ctx.moveTo(p0[0], p0[1]);
  ctx.quadraticCurveTo(q0[0], q0[1], p1[0], p1[1]);
  ctx.quadraticCurveTo(q1[0], q1[1], p2[0], p2[1]);
  ctx.quadraticCurveTo(q2[0], q2[1], p3[0], p3[1]);
  ctx.quadraticCurveTo(q3[0], q3[1], p0[0], p0[1]);
  ctx.closePath();
}

// sparkles: twinkling 4-point glints with glow cores
function sparkles(ctx, t, w, h, o, H) {
  const { S, cols } = o;
  const T = t * o.speed;
  const n = Math.min(200, Math.round(34 * o.density));
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const per = 1.5 + H(i, 0) * 2.2;
    const c = T / per + H(i, 1);
    const cyc = Math.floor(c);
    const life = 0.5 + H(i, 2) * 0.35;
    const v = (c - cyc) / life;
    if (v >= 1) continue;
    const env = v < 0.28 ? 1 - Math.pow(1 - v / 0.28, 3) : Math.pow(1 - (v - 0.28) / 0.72, 2);
    const j = i * 131 + cyc * 7;
    const x = (0.04 + 0.92 * H(j, 3)) * w;
    const y = (0.04 + 0.92 * H(j, 4)) * h;
    const big = Math.pow(H(j, 5), 2.2);
    const R = (12 + big * 46) * S * o.size * env;
    const col = cols[Math.floor(H(j, 6) * cols.length) % cols.length];
    const rot = (H(j, 7) - 0.5) * 0.5 + (v - 0.5) * 0.6;
    blit(ctx, sprite('glow', col), x, y, R * 1.6, 0.55 * env);
    ctx.globalAlpha = env;
    ctx.fillStyle = rgba(col, 0.95);
    starPath(ctx, x, y, R, rot, 0.09);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    starPath(ctx, x, y, R * 0.55, rot, 0.12);
    ctx.fill();
    if (big > 0.35) {
      // thin anamorphic flare
      const L = R * 3.2;
      const g = ctx.createLinearGradient(x - L, y, x + L, y);
      g.addColorStop(0, rgba(col, 0));
      g.addColorStop(0.5, rgba(col, 0.45 * env));
      g.addColorStop(1, rgba(col, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.fillRect(x - L, y - 0.9 * S, L * 2, 1.8 * S);
    }
    blit(ctx, sprite('soft', '#FFFFFF'), x, y, R * 0.35, env);
  }
}

// bokeh: soft out-of-focus discs drifting upward
function bokeh(ctx, t, w, h, o, H) {
  const { S, m, cols } = o;
  const T = t * o.speed;
  const n = Math.min(90, Math.round(16 * o.density));
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const depth = H(i, 0);
    const r = (0.035 + Math.pow(depth, 1.6) * 0.15) * m * o.size;
    const vx = (H(i, 1) - 0.5) * 24 * S;
    const vy = -(6 + depth * 26) * S;
    const wob = Math.sin(T * (0.3 + H(i, 2) * 0.4) + H(i, 3) * TAU) * 30 * S;
    const x = mod(H(i, 4) * (w + 2 * r) + vx * T + wob, w + 2 * r) - r;
    const y = mod(H(i, 5) * (h + 2 * r) + vy * T, h + 2 * r) - r;
    const col = cols[Math.floor(H(i, 6) * cols.length) % cols.length];
    const breathe = 0.78 + 0.22 * Math.sin(T * (0.5 + H(i, 7) * 0.7) + H(i, 8) * TAU);
    const a = (0.22 + (1 - depth) * 0.35) * breathe;
    if (depth > 0.82) blit(ctx, sprite('soft', col), x, y, r * 1.3, a * 0.8);
    else blit(ctx, sprite('bokeh', col), x, y, r, a);
  }
}

// rays: volumetric god rays rendered at low res for soft edges
function rays(ctx, t, w, h, o, H) {
  const { cols } = o;
  const T = t * o.speed;
  const q = 6;
  const lw = Math.max(8, Math.ceil(w / q)), lh = Math.max(8, Math.ceil(h / q));
  const [c, g] = layer('rays', lw, lh);
  const sx = lw * 0.5, sy = -lh * 0.06;
  const L = Math.hypot(lw, lh) * 1.15;
  const n = Math.min(40, Math.round(8 + 6 * o.density));
  g.globalCompositeOperation = 'lighter';
  const sway = Math.sin(T * 0.22) * 0.07 + T * 0.012;
  for (let i = 0; i < n; i++) {
    const col = cols[i % cols.length];
    const grad = g.createRadialGradient(sx, sy, 0, sx, sy, L * (0.55 + H(i, 5) * 0.45));
    grad.addColorStop(0, rgba(col, 0.9));
    grad.addColorStop(0.35, rgba(col, 0.42));
    grad.addColorStop(1, rgba(col, 0));
    const a = Math.PI / 2 + (H(i, 0) - 0.5) * 1.75 + sway * (0.6 + H(i, 1) * 0.8);
    const wd = (0.012 + Math.pow(H(i, 2), 1.5) * 0.06) * o.size;
    const pulse = 0.55 + 0.45 * Math.sin(T * (0.5 + H(i, 3) * 0.9) + H(i, 4) * TAU);
    g.globalAlpha = (0.18 + H(i, 6) * 0.32) * pulse;
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(sx, sy);
    g.lineTo(sx + Math.cos(a - wd) * L, sy + Math.sin(a - wd) * L);
    g.lineTo(sx + Math.cos(a + wd) * L, sy + Math.sin(a + wd) * L);
    g.closePath();
    g.fill();
  }
  // source bloom
  const br = lh * 0.42 * (0.95 + 0.05 * Math.sin(T * 1.3));
  const bg = g.createRadialGradient(sx, sy, 0, sx, sy, br);
  bg.addColorStop(0, rgba(cols[0], 0.75));
  bg.addColorStop(0.4, rgba(cols[0], 0.22));
  bg.addColorStop(1, rgba(cols[0], 0));
  g.globalAlpha = 1;
  g.fillStyle = bg;
  g.fillRect(0, 0, lw, lh);
  composite(ctx, c, w, h, 'lighter', 0.85);
}

// speed-lines: radial (default) or horizontal motion streaks
function speedLines(ctx, t, w, h, o, H) {
  const { S, m, cols } = o;
  const T = t * o.speed;
  const n = Math.min(300, Math.round(70 * o.density));
  const horizontal = o.mode === 'horizontal';
  ctx.globalCompositeOperation = 'lighter';
  const cx = w / 2, cy = h / 2;
  const R = Math.hypot(w, h) / 2;
  const r0 = m * 0.3;
  for (let i = 0; i < n; i++) {
    const per = 0.32 + H(i, 0) * 0.45;
    const c = T / per + H(i, 1);
    const cyc = Math.floor(c);
    const u = c - cyc;
    const j = i * 61 + cyc * 13;
    const col = cols[Math.floor(H(j, 2) * cols.length) % cols.length];
    const th = (2.5 + Math.pow(H(j, 3), 2) * 9) * S * o.size;
    const env = Math.sin(Math.PI * u);
    const a = (0.25 + 0.75 * H(j, 4)) * env;
    let x0, y0, x1, y1, nx, ny;
    if (horizontal) {
      const len = (0.25 + H(j, 5) * 0.55) * w;
      const y = H(j, 6) * h;
      const xh = w + len - u * (w + 2 * len) * 1.0;
      x0 = xh + len; y0 = y; x1 = xh; y1 = y;
      nx = 0; ny = 1;
    } else {
      const ang = H(j, 7) * TAU;
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const head = r0 + (R * 1.1 - r0) * Math.pow(u, 1.5);
      const len = (0.12 + H(j, 5) * 0.32) * R * (0.4 + u);
      const tail = Math.max(r0 * 0.85, head - len);
      x0 = cx + dx * tail; y0 = cy + dy * tail; x1 = cx + dx * head; y1 = cy + dy * head;
      nx = -dy; ny = dx;
    }
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, rgba(col, 0));
    g.addColorStop(0.75, rgba(col, a * 0.7));
    g.addColorStop(1, rgba(col, a));
    ctx.fillStyle = g;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1 + nx * th * 0.5, y1 + ny * th * 0.5);
    ctx.lineTo(x1 - nx * th * 0.5, y1 - ny * th * 0.5);
    ctx.closePath();
    ctx.fill();
  }
}

// light-leak: warm blurred blobs drifting along the frame edges
function lightLeak(ctx, t, w, h, o, H) {
  const { cols } = o;
  const T = t * o.speed;
  const q = 8;
  const lw = Math.max(8, Math.ceil(w / q)), lh = Math.max(8, Math.ceil(h / q));
  const lm = Math.min(lw, lh);
  const [c, g] = layer('leak', lw, lh);
  g.globalCompositeOperation = 'lighter';
  const n = Math.min(10, 3 + Math.round(o.density * 1.5));
  const D = o.duration > 0.5 ? o.duration : 6;
  const sweep = (t / D) * 0.35;
  for (let i = 0; i < n; i++) {
    const side = Math.floor(H(i, 0) * 3);
    const along = H(i, 1) + sweep * (H(i, 2) < 0.5 ? 1 : -1) + 0.18 * Math.sin(T * (0.18 + H(i, 3) * 0.2) + H(i, 4) * TAU);
    const inset = (H(i, 5) - 0.35) * 0.18 + 0.06 * Math.sin(T * 0.27 + i);
    let x, y;
    if (side === 0) { x = inset * lw; y = (0.1 + 0.8 * fract(along)) * lh; }
    else if (side === 1) { x = (1 - inset) * lw; y = (0.1 + 0.8 * fract(along)) * lh; }
    else { x = fract(along) * lw; y = inset * lh * 0.6; }
    const r = (0.38 + 0.42 * H(i, 6)) * lm * o.size;
    const col = cols[i % cols.length];
    const breathe = 0.55 + 0.45 * Math.pow(Math.sin(T * (0.35 + H(i, 7) * 0.3) + H(i, 8) * TAU) * 0.5 + 0.5, 1.5);
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, rgba(col, 0.85));
    grad.addColorStop(0.35, rgba(col, 0.45));
    grad.addColorStop(0.7, rgba(col, 0.12));
    grad.addColorStop(1, rgba(col, 0));
    g.globalAlpha = breathe * 0.75;
    g.save();
    g.translate(x, y);
    g.rotate(H(i, 9) * TAU + T * 0.05);
    g.scale(1.6, 0.75);
    g.translate(-x, -y);
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
    g.restore();
  }
  // diagonal flare band sweeping across
  const P = Math.max(3, D * 0.9);
  const u = fract(T / P + H(99, 0));
  const bx = (-0.4 + 1.8 * u) * lw;
  const band = g.createLinearGradient(bx - lm * 0.5, 0, bx + lm * 0.5, lh * 0.3);
  const bc = cols[1 % cols.length];
  const ba = Math.sin(Math.PI * u) * 0.35;
  band.addColorStop(0, rgba(bc, 0));
  band.addColorStop(0.5, rgba(bc, ba));
  band.addColorStop(1, rgba(bc, 0));
  g.globalAlpha = 1;
  g.fillStyle = band;
  g.fillRect(0, 0, lw, lh);
  composite(ctx, c, w, h, 'screen', 0.95);
}

// dust: tiny motes with closed-form brownian drift
function dust(ctx, t, w, h, o, H) {
  const { S, cols } = o;
  const T = t * o.speed;
  const n = Math.min(MAX_PARTICLES, Math.round(220 * o.density));
  ctx.globalCompositeOperation = 'lighter';
  const bx = w * 0.62, by = 0, bdx = -0.42, bdy = 0.91;
  const bw = Math.min(w, h) * 0.45;
  for (let i = 0; i < n; i++) {
    const z = H(i, 0);
    const near = z > 0.9;
    const ph = H(i, 1) * TAU;
    const A = (10 + z * 30) * S;
    const dx = A * (Math.sin(T * (0.21 + H(i, 2) * 0.2) + ph) + 0.5 * Math.sin(T * (0.53 + H(i, 3) * 0.4) + ph * 2.3));
    const dy = A * (Math.cos(T * (0.17 + H(i, 4) * 0.2) + ph * 1.7) + 0.5 * Math.sin(T * (0.47 + H(i, 5) * 0.4) + ph * 3.1));
    const x = mod(H(i, 6) * w + dx + T * (H(i, 7) - 0.5) * 8 * S, w);
    const y = mod(H(i, 8) * h + dy - T * (3 + z * 7) * S, h);
    // brighter inside a soft diagonal shaft
    const px = x - bx, py = y - by;
    const d = Math.abs(px * bdy - py * bdx) / bw;
    const lit = 0.35 + 0.65 * Math.exp(-d * d * 2);
    const tw = 0.6 + 0.4 * Math.sin(T * (0.8 + H(i, 9) * 2.2) + ph * 5);
    const col = cols[Math.floor(H(i, 10) * cols.length) % cols.length];
    if (near) {
      const r = (10 + H(i, 11) * 16) * S * o.size;
      blit(ctx, sprite('soft', col), x, y, r, 0.4 * lit * tw);
    } else {
      const r = (1.4 + Math.pow(z, 2) * 3.2) * S * o.size;
      blit(ctx, sprite('dot', col), x, y, r * 1.4, (0.45 + 0.55 * z) * lit * tw);
      if (z > 0.6) blit(ctx, sprite('soft', col), x, y, r * 5, 0.12 * lit * tw);
    }
  }
}

// glow-orbs: large luminous orbs on slow elliptical orbits
function glowOrbs(ctx, t, w, h, o, H) {
  const { cols } = o;
  const T = t * o.speed;
  const q = 4;
  const lw = Math.max(8, Math.ceil(w / q)), lh = Math.max(8, Math.ceil(h / q));
  const lm = Math.min(lw, lh);
  const [c, g] = layer('orbs', lw, lh);
  g.globalCompositeOperation = 'lighter';
  const n = clamp(Math.round(3 + 1.5 * o.density), 1, 12);
  for (let i = 0; i < n; i++) {
    const cx = (0.2 + 0.6 * H(i, 0)) * lw, cy = (0.15 + 0.7 * H(i, 1)) * lh;
    const ax = (0.12 + 0.22 * H(i, 2)) * lw, ay = (0.08 + 0.18 * H(i, 3)) * lh;
    const dir = H(i, 4) < 0.5 ? -1 : 1;
    const ang = H(i, 5) * TAU + dir * T * (0.12 + 0.14 * H(i, 6));
    const x = cx + Math.cos(ang) * ax, y = cy + Math.sin(ang) * ay;
    const R = (0.3 + 0.28 * H(i, 7)) * lm * o.size;
    const col = cols[i % cols.length];
    const br = 0.8 + 0.2 * Math.sin(T * (0.4 + H(i, 8) * 0.4) + H(i, 9) * TAU);
    blit(g, sprite('soft', col), x, y, R, 0.55 * br);
    blit(g, sprite('soft', mixColor(col, '#FFFFFF', 0.35)), x, y, R * 0.38, 0.32 * br);
  }
  composite(ctx, c, w, h, 'screen', 1);
}

// grid: synthwave perspective floor scrolling toward the viewer
function grid(ctx, t, w, h, o, H) {
  const { S, cols } = o;
  const T = t * o.speed;
  const lineCol = cols[0], glowCol = cols[1 % cols.length];
  const yH = h * 0.56;
  const fh = h - yH;
  const cx = w / 2 + Math.sin(T * 0.25 + H(0, 0) * TAU) * w * 0.04;
  const d = clamp(o.density, 0.25, 4);
  ctx.globalCompositeOperation = 'lighter';
  // horizon glow
  const hg = ctx.createLinearGradient(0, yH - fh * 0.35, 0, yH + fh * 0.25);
  hg.addColorStop(0, rgba(glowCol, 0));
  hg.addColorStop(0.58, rgba(glowCol, 0.22));
  hg.addColorStop(1, rgba(glowCol, 0));
  ctx.fillStyle = hg;
  ctx.fillRect(0, yH - fh * 0.35, w, fh * 0.6);
  const thin = 1.6 * S * o.size, wide = 7 * S * o.size;
  // receding cross lines
  const gap = 0.55 / Math.sqrt(d);
  const off = fract(T * 0.9 / (gap * 1.5)) * gap;
  for (let k = 0; k < 120; k++) {
    const z = 0.55 + k * gap - off;
    const y = yH + fh / z;
    if (y > h + wide) continue;
    if (y - yH < 1) break;
    const a = smooth(0, fh * 0.35, y - yH) * clamp(1.6 / z, 0, 1);
    if (a < 0.01) continue;
    for (let p = 0; p < 2; p++) {
      ctx.strokeStyle = p ? rgba('#FFFFFF', 0.45 * a) : rgba(lineCol, 0.42 * a);
      ctx.lineWidth = (p ? thin : wide) * clamp(1.2 / z, 0.35, 1.4);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      if (p) {
        ctx.strokeStyle = rgba(lineCol, 0.9 * a);
        ctx.lineWidth = thin * 1.8 * clamp(1.2 / z, 0.35, 1.4);
        ctx.stroke();
      }
    }
  }
  // converging lines with depth fade
  const cols2 = Math.round(9 * Math.sqrt(d));
  const sp = w / cols2;
  const zb = 0.2;
  const yB = yH + fh / zb;
  const vg = ctx.createLinearGradient(0, yH, 0, h);
  vg.addColorStop(0, rgba(lineCol, 0));
  vg.addColorStop(0.12, rgba(lineCol, 0));
  vg.addColorStop(0.45, rgba(lineCol, 0.6));
  vg.addColorStop(1, rgba(lineCol, 1));
  const vgw = ctx.createLinearGradient(0, yH, 0, h);
  vgw.addColorStop(0, rgba(lineCol, 0));
  vgw.addColorStop(0.25, rgba(lineCol, 0));
  vgw.addColorStop(1, rgba(lineCol, 0.5));
  ctx.beginPath();
  for (let j = -cols2 * 4; j <= cols2 * 4; j++) {
    const xb = cx + ((j + 0.5) * sp) / zb;
    ctx.moveTo(cx, yH);
    ctx.lineTo(xb, yB);
  }
  ctx.strokeStyle = vgw;
  ctx.lineWidth = wide;
  ctx.stroke();
  ctx.strokeStyle = vg;
  ctx.lineWidth = thin * 1.6;
  ctx.stroke();
}

// waves: layered flowing silk ribbons
function waves(ctx, t, w, h, o, H) {
  const { S, cols } = o;
  const T = t * o.speed;
  const L = clamp(Math.round(3 + o.density * 1.2), 1, 9);
  const step = Math.max(6, 14 * S);
  const N = Math.ceil(w / step) + 1;
  const up = new Float32Array(N), lo = new Float32Array(N);
  const amp = h * 0.06 * o.size;
  for (let j = 0; j < L; j++) {
    const f = L > 1 ? j / (L - 1) : 0.5;
    const ph = H(j, 0) * TAU;
    const k1 = (1.6 + H(j, 1) * 1.6) / w * TAU / 2, k2 = (2.5 + H(j, 2) * 2.5) / w * TAU / 2;
    const w1 = 0.35 + H(j, 3) * 0.35, w2 = 0.22 + H(j, 4) * 0.3;
    const thick = h * (0.035 + H(j, 5) * 0.05) * o.size;
    const by = h * (0.5 + (f - 0.5) * 0.22);
    for (let s = 0; s < N; s++) {
      const x = s * step;
      const tilt = (x / w - 0.5) * h * 0.16;
      const c = by - tilt + amp * Math.sin(x * k1 + T * w1 + ph) + amp * 0.55 * Math.sin(x * k2 - T * w2 + ph * 1.7);
      const th = thick * (0.45 + 0.55 * (0.5 + 0.5 * Math.sin(x * k1 * 0.7 + T * 0.4 + ph * 2.1)));
      up[s] = c - th; lo[s] = c + th;
    }
    const c1 = cols[j % cols.length], c2 = cols[(j + 1) % cols.length];
    const gr = ctx.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0, rgba(c1, 0));
    gr.addColorStop(0.25, rgba(c1, 0.42));
    gr.addColorStop(0.7, rgba(c2, 0.42));
    gr.addColorStop(1, rgba(c2, 0.05));
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.moveTo(0, up[0]);
    for (let s = 1; s < N; s++) ctx.lineTo(s * step, up[s]);
    for (let s = N - 1; s >= 0; s--) ctx.lineTo(s * step, lo[s]);
    ctx.closePath();
    ctx.fill();
    // silk strands
    const lg = ctx.createLinearGradient(0, 0, w, 0);
    lg.addColorStop(0, rgba(c1, 0));
    lg.addColorStop(0.3, rgba(mixColor(c1, '#FFFFFF', 0.5), 0.55));
    lg.addColorStop(0.75, rgba(mixColor(c2, '#FFFFFF', 0.5), 0.55));
    lg.addColorStop(1, rgba(c2, 0));
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = lg;
    const strands = 7;
    for (let q = 0; q <= strands; q++) {
      const fq = q / strands;
      ctx.globalAlpha = q === 0 ? 0.9 : 0.28;
      ctx.lineWidth = (q === 0 ? 1.8 : 1.1) * S;
      ctx.beginPath();
      for (let s = 0; s < N; s++) {
        const y = up[s] + (lo[s] - up[s]) * fq;
        if (s === 0) ctx.moveTo(0, y); else ctx.lineTo(s * step, y);
      }
      ctx.stroke();
    }
  }
}

// snow: parallax flakes with sway and wind
function snow(ctx, t, w, h, o, H) {
  const { S, cols } = o;
  const T = t * o.speed;
  const n = Math.min(MAX_PARTICLES, Math.round(170 * o.density));
  ctx.globalCompositeOperation = 'source-over';
  for (let i = 0; i < n; i++) {
    const z = Math.pow(H(i, 0), 1.6);
    const r = (2.6 + z * 11) * S * o.size;
    const m = r * 2 + 10 * S;
    const vy = (45 + z * 170) * S;
    const sway = (8 + z * 26) * S * Math.sin(T * (0.6 + H(i, 1) * 0.8) + H(i, 2) * TAU);
    const x = mod(H(i, 3) * w + T * (12 + z * 30) * S + sway, w + 2 * m) - m;
    const y = mod(H(i, 4) * (h + 2 * m) + vy * T, h + 2 * m) - m;
    const col = cols[Math.floor(H(i, 5) * cols.length) % cols.length];
    if (z > 0.75) blit(ctx, sprite('soft', col), x, y, r * 2, 0.6);
    else blit(ctx, sprite('flake', col), x, y, r, 0.5 + 0.5 * z);
  }
}

// stars: starfield with slow forward zoom and twinkle
function stars(ctx, t, w, h, o, H) {
  const { S, cols } = o;
  const T = t * o.speed;
  const n = Math.min(MAX_PARTICLES, Math.round(280 * o.density));
  const cx = w / 2, cy = h / 2;
  const spread = Math.max(w, h) * 0.62;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const zf = fract(H(i, 0) - T * 0.022);
    const zz = 0.18 + 0.82 * zf;
    const x = cx + ((H(i, 1) - 0.5) * 2 * spread) / zz * 0.5;
    const y = cy + ((H(i, 2) - 0.5) * 2 * spread) / zz * 0.5;
    if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;
    const mag = Math.pow(H(i, 3), 5);
    const fade = smooth(0, 0.12, zf) * smooth(1, 0.8, zf);
    const tw = 0.7 + 0.3 * Math.sin(T * (1.2 + H(i, 4) * 3.5) + H(i, 5) * TAU);
    const a = (0.3 + 0.7 * mag) * fade * tw * (1.15 - zz * 0.5);
    const r = (0.7 + 2.0 * mag) * S * o.size / Math.sqrt(zz);
    const col = cols[Math.floor(H(i, 6) * cols.length) % cols.length];
    blit(ctx, sprite('dot', col), x, y, r * 1.3, a);
    if (mag > 0.45) {
      blit(ctx, sprite('glow', col), x, y, r * 7, a * 0.45);
      const L = r * 9;
      ctx.globalAlpha = a * 0.5;
      ctx.fillStyle = rgba(col, 0.8);
      starPath(ctx, x, y, L, 0, 0.03);
      ctx.fill();
    }
  }
}

// shockwave: expanding glowing rings from center, repeating
function shockwave(ctx, t, w, h, o, H) {
  const { S, m, cols } = o;
  const T = t * o.speed;
  const P = 1.2, life = 1.15;
  const cx = w / 2, cy = h / 2;
  const Rmax = Math.hypot(w, h) * 0.5 * o.size;
  const echoes = clamp(Math.round(o.density * 2), 1, 8);
  const ringCol = cols[0], hot = cols[1 % cols.length];
  const repeat = o.repeat !== false;
  ctx.globalCompositeOperation = 'lighter';
  const first = repeat ? Math.max(0, Math.floor((T - life - 0.5) / P)) : 0;
  const last = repeat ? Math.floor(T / P) : 0;
  for (let wv = first; wv <= last; wv++) {
    const t0 = wv * P;
    for (let e = 0; e < echoes; e++) {
      const u = (T - t0 - e * 0.09) / life;
      if (u < 0 || u >= 1) continue;
      const ease = 1 - Math.pow(1 - u, 3);
      const r = ease * Rmax * (1 - e * 0.06);
      const th = ((e === 0 ? 46 : 18) * Math.pow(1 - u, 1.2) + 2) * S * o.size;
      const a = Math.pow(1 - u, 1.6) * (e === 0 ? 1 : 0.5 / e);
      const r1 = Math.max(0, r - th * 2), r2 = r + th;
      const g = ctx.createRadialGradient(cx, cy, r1, cx, cy, r2);
      g.addColorStop(0, rgba(ringCol, 0));
      g.addColorStop(0.4, rgba(ringCol, 0.28 * a));
      g.addColorStop(0.8, rgba(hot, 0.95 * a));
      g.addColorStop(0.87, rgba(ringCol, 0.55 * a));
      g.addColorStop(1, rgba(ringCol, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r2, 0, TAU);
      if (r1 > 0) ctx.arc(cx, cy, r1, 0, TAU, true);
      ctx.fill('evenodd');
      // crisp leading edge
      ctx.strokeStyle = rgba(hot, 0.9 * a);
      ctx.lineWidth = Math.max(1, th * 0.12);
      ctx.beginPath();
      ctx.arc(cx, cy, r + th * 0.45, 0, TAU);
      ctx.stroke();
    }
    // impact flash and sparks
    const uf = (T - t0) / 0.35;
    if (uf >= 0 && uf < 1) {
      const fa = Math.pow(1 - uf, 2);
      blit(ctx, sprite('glow', hot), cx, cy, m * (0.25 + 0.35 * uf) * o.size, fa);
    }
    const us = (T - t0) / 0.8;
    if (us >= 0 && us < 1) {
      const sa = Math.pow(1 - us, 1.5);
      const ns = 18 + Math.round(6 * o.density);
      ctx.strokeStyle = rgba(hot, 0.85 * sa);
      ctx.lineCap = 'round';
      ctx.lineWidth = 2.2 * S * o.size;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      for (let k = 0; k < ns; k++) {
        const ang = H(wv * 50 + k, 1) * TAU;
        const rr = (1 - Math.pow(1 - us, 2.4)) * m * (0.25 + 0.3 * H(wv * 50 + k, 2)) * o.size;
        const len = (20 + 50 * H(wv * 50 + k, 3)) * S * (1 - us);
        ctx.moveTo(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr);
        ctx.lineTo(cx + Math.cos(ang) * (rr + len), cy + Math.sin(ang) * (rr + len));
      }
      ctx.stroke();
    }
  }
}

// scanlines: CRT line texture with a rolling noise band
const patterns = new WeakMap();
function scanPattern(ctx, p) {
  let byCtx = patterns.get(ctx);
  if (!byCtx) { byCtx = new Map(); patterns.set(ctx, byCtx); }
  let pat = byCtx.get(p);
  if (pat) return pat;
  const c = makeCanvas(4, p);
  const g = c.getContext('2d');
  const dark = Math.max(1, Math.round(p * 0.5));
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(0, 0, 4, dark);
  g.fillStyle = 'rgba(255,255,255,0.07)';
  g.fillRect(0, dark, 4, Math.max(1, Math.round(p * 0.25)));
  pat = ctx.createPattern(c, 'repeat');
  byCtx.set(p, pat);
  return pat;
}
function scanlines(ctx, t, w, h, o, H) {
  const { S, cols } = o;
  const T = t * o.speed;
  const p = Math.max(2, Math.round(4 * S * o.size));
  const strength = clamp(o.density, 0, 4);
  const flick = 0.94 + 0.06 * Math.sin(T * 47);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = clamp(0.22 * strength * flick, 0, 1);
  ctx.fillStyle = scanPattern(ctx, p);
  ctx.fillRect(0, 0, w, h);
  // rolling band
  const bandH = h * 0.14;
  const by = fract(T * 0.16) * (h + bandH * 2) - bandH;
  const col = cols[0];
  const g = ctx.createLinearGradient(0, by - bandH / 2, 0, by + bandH / 2);
  g.addColorStop(0, rgba(col, 0));
  g.addColorStop(0.5, rgba(col, 0.06 * Math.min(2, strength)));
  g.addColorStop(1, rgba(col, 0));
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.fillRect(0, by - bandH / 2, w, bandH);
  // glitch slivers, frame quantized
  const fq = Math.floor(T * 24);
  const ns = 5 + Math.round(3 * strength);
  for (let k = 0; k < ns; k++) {
    const j = fq * 17 + k;
    const y = by + (H(j, 0) - 0.5) * bandH * 0.9;
    const sh = (1 + H(j, 1) * 3) * S;
    const sw = (0.15 + 0.7 * H(j, 2)) * w;
    const sx = H(j, 3) * (w - sw);
    ctx.fillStyle = rgba(col, (0.03 + 0.08 * H(j, 4)) * Math.min(2, strength));
    ctx.fillRect(sx, y, sw, sh);
  }
}

const EFFECTS = {
  confetti, sparkles, bokeh, rays, 'speed-lines': speedLines, 'light-leak': lightLeak, dust,
  'glow-orbs': glowOrbs, grid, waves, snow, stars, shockwave, scanlines,
};

export function drawEffect(ctx, name, t, w, h, opts) {
  const fn = EFFECTS[name];
  if (!fn || !ctx || !(w > 0) || !(h > 0)) return;
  const op = opts || {};
  const density = clamp(num(op.density, 1), 0, 4);
  if (density <= 0) return;
  const colors = Array.isArray(op.colors) ? op.colors.filter((c) => typeof c === 'string' && c.trim()) : [];
  const o = {
    cols: colors.length ? colors : DEFAULTS[name],
    density,
    speed: Math.max(0, num(op.speed, 1)),
    size: clamp(num(op.size, 1), 0.05, 10),
    seed: num(op.seed, 0),
    duration: Math.max(0, num(op.duration, 0)),
    mode: op.mode,
    repeat: op.repeat,
    S: Math.min(w, h) / 1080,
    m: Math.min(w, h),
  };
  const time = Math.max(0, num(t, 0));
  ctx.save();
  try {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    fn(ctx, time, w, h, o, makeHash(o.seed));
  } finally {
    ctx.restore();
  }
}
