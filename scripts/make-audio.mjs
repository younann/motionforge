#!/usr/bin/env node
// Synthesizes the bundled music and sfx library (CC0).
// Usage: node scripts/make-audio.mjs [--only id,id]
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'audio');
const pickBin = (name) => {
  const brew = `/opt/homebrew/bin/${name}`;
  return existsSync(brew) ? brew : name;
};
const FFMPEG = process.env.FFMPEG || pickBin('ffmpeg');
const FFPROBE = process.env.FFPROBE || pickBin('ffprobe');

const SR = 44100;
const TAU = Math.PI * 2;

// ---------- utils ----------

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
let rnd = mulberry32(1);
const seed = (s) => { rnd = mulberry32(hashStr(s)); };
const noise = () => rnd() * 2 - 1;
const rr = (a, b) => a + (b - a) * rnd();

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function nm(s) {
  if (typeof s === 'number') return s;
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(s);
  if (!m) throw new Error(`bad note ${s}`);
  return 12 * (+m[3] + 1) + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const hz = (s) => mtof(nm(s));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (x) => x * x * (3 - 2 * x);

const stereo = (n) => ({ L: new Float32Array(n), R: new Float32Array(n) });

function addMono(dst, sig, t, gain = 1, pan = 0) {
  const s0 = Math.round(t * SR);
  const a = ((clamp(pan, -1, 1) + 1) * Math.PI) / 4;
  const gl = Math.cos(a) * Math.SQRT2 * gain, gr = Math.sin(a) * Math.SQRT2 * gain;
  const n = Math.min(sig.length, dst.L.length - s0);
  for (let i = Math.max(0, -s0); i < n; i++) { dst.L[s0 + i] += sig[i] * gl; dst.R[s0 + i] += sig[i] * gr; }
}
function addStereo(dst, src, t, gain = 1) {
  const s0 = Math.round(t * SR);
  const n = Math.min(src.L.length, dst.L.length - s0);
  for (let i = Math.max(0, -s0); i < n; i++) { dst.L[s0 + i] += src.L[i] * gain; dst.R[s0 + i] += src.R[i] * gain; }
}
function fadeEnd(x, ms = 4) {
  const k = Math.min(x.length, Math.round((ms / 1000) * SR));
  for (let i = 0; i < k; i++) x[x.length - 1 - i] *= i / k;
  return x;
}
function fadeEndS(s, ms = 4) { fadeEnd(s.L, ms); fadeEnd(s.R, ms); return s; }
function reverseS(s) { s.L.reverse(); s.R.reverse(); return s; }
function peakOf(s) {
  let p = 0;
  for (let i = 0; i < s.L.length; i++) p = Math.max(p, Math.abs(s.L[i]), Math.abs(s.R[i]));
  return p;
}

// ---------- filters ----------

function biquad(type, f, q = 0.7071, gainDb = 0) {
  const w = (TAU * Math.min(f, SR * 0.45)) / SR, cs = Math.cos(w), sn = Math.sin(w);
  const al = sn / (2 * q), A = 10 ** (gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
  else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
  else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
  else if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; }
  else if (type === 'hs' || type === 'ls') {
    const s2 = 2 * Math.sqrt(A) * al;
    if (type === 'hs') {
      b0 = A * (A + 1 + (A - 1) * cs + s2); b1 = -2 * A * (A - 1 + (A + 1) * cs); b2 = A * (A + 1 + (A - 1) * cs - s2);
      a0 = A + 1 - (A - 1) * cs + s2; a1 = 2 * (A - 1 - (A + 1) * cs); a2 = A + 1 - (A - 1) * cs - s2;
    } else {
      b0 = A * (A + 1 - (A - 1) * cs + s2); b1 = 2 * A * (A - 1 - (A + 1) * cs); b2 = A * (A + 1 - (A - 1) * cs - s2);
      a0 = A + 1 + (A - 1) * cs + s2; a1 = -2 * (A - 1 + (A + 1) * cs); a2 = A + 1 + (A - 1) * cs - s2;
    }
  } else throw new Error(type);
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
function filt(x, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    const y = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = y; x[i] = y;
  }
  return x;
}
const filtS = (s, c) => { filt(s.L, c); filt(s.R, c); return s; };

// state variable filter, modulatable
class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.lp = 0; this.bp = 0; this.hp = 0; this.set(1000, 0.7); }
  set(fc, q) {
    const g = Math.tan((Math.PI * clamp(fc, 10, SR * 0.48)) / SR);
    this.k = 1 / q; this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  proc(v0) {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.bp = v1; this.hp = v0 - this.k * v1 - v2;
    return v2;
  }
}

// ---------- envelopes / oscillators ----------

function adsr(t, dur, a, d, s, r) {
  const tt = t < dur ? t : dur;
  let v = tt < a ? tt / a : s + (1 - s) * Math.exp(-(tt - a) / Math.max(d, 1e-4));
  if (t > dur) { const k = 1 - (t - dur) / r; v *= k > 0 ? k * k : 0; }
  return v;
}
function blepSaw(p, dt) {
  let v = 2 * p - 1;
  if (p < dt) { const t = p / dt; v -= t + t - t * t - 1; }
  else if (p > 1 - dt) { const t = (p - 1) / dt; v -= t * t + t + t + 1; }
  return v;
}

// ---------- drums ----------

function kick({ f0 = 150, f1 = 48, pd = 0.04, ad = 0.32, hold = 0.03, len = 0.55, click = 0.4, drive = 1.6 } = {}) {
  const n = Math.round(len * SR), o = new Float32Array(n);
  const hp = new SVF(); hp.set(2500, 0.7);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (f1 + (f0 - f1) * Math.exp(-t / pd)) / SR;
    const amp = t < hold ? 1 : Math.exp(-(t - hold) / ad);
    let s = Math.sin(TAU * ph) * amp;
    hp.proc(noise());
    s += (hp.hp * 0.6 + Math.sin(TAU * 1400 * t) * 0.5) * click * Math.exp(-t / 0.004);
    o[i] = Math.tanh(s * drive) / Math.tanh(drive);
  }
  return fadeEnd(o, 8);
}

function snare({ tone = 190, decay = 0.16, bodyAmt = 0.55, noiseAmt = 0.7, hpf = 1400, lpf = 9000, len = 0.4 } = {}) {
  const n = Math.round(len * SR), o = new Float32Array(n);
  const f1 = new SVF(), f2 = new SVF(); f1.set(hpf, 0.7); f2.set(lpf, 0.7);
  let ph = 0, ph2 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = tone * (1 + 0.6 * Math.exp(-t / 0.012));
    ph += f / SR; ph2 += (f * 1.52) / SR;
    const body = (Math.sin(TAU * ph) + 0.45 * Math.sin(TAU * ph2)) * Math.exp(-t / 0.055);
    f1.proc(noise()); f2.proc(f1.hp);
    const nz = f2.lp * Math.exp(-t / decay) * (1 - Math.exp(-t / 0.0008));
    o[i] = Math.tanh((body * bodyAmt + nz * noiseAmt * 1.6) * 1.2);
  }
  return fadeEnd(o, 10);
}

function clap({ len = 0.45, tail = 0.13, f = 1150 } = {}) {
  const n = Math.round(len * SR), o = new Float32Array(n);
  const bp = new SVF(); bp.set(f, 1.1);
  const hp = new SVF(); hp.set(600, 0.7);
  const bursts = [0, 0.009, 0.019, 0.028];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let e = 0;
    for (const b of bursts) if (t >= b && t < 0.032) e = Math.max(e, Math.exp(-(t - b) / 0.0035));
    if (t >= 0.028) e = Math.max(e, 0.8 * Math.exp(-(t - 0.028) / tail));
    bp.proc(noise()); hp.proc(bp.bp);
    o[i] = hp.hp * e * 2.2;
  }
  return fadeEnd(o, 10);
}

function hat({ decay = 0.04, open = false, len, hpf = 7000 } = {}) {
  len = len ?? (open ? decay * 5 : 0.18);
  const n = Math.round(len * SR), o = new Float32Array(n);
  const freqs = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0].map((f) => f * 1.7);
  const ph = freqs.map(() => rnd());
  const h1 = new SVF(), h2 = new SVF(), lp = new SVF();
  h1.set(hpf, 0.7); h2.set(hpf, 0.7); lp.set(14000, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let m = 0;
    for (let k = 0; k < freqs.length; k++) { ph[k] = (ph[k] + freqs[k] / SR) % 1; m += ph[k] < 0.5 ? 1 : -1; }
    const src = m * 0.12 + noise() * 0.7;
    h1.proc(src); h2.proc(h1.hp); lp.proc(h2.hp);
    const e = Math.exp(-t / decay) * (1 - Math.exp(-t / 0.0005));
    o[i] = lp.lp * e;
  }
  return fadeEnd(o, 5);
}

function shaker({ len = 0.12, decay = 0.035 } = {}) {
  const n = Math.round(len * SR), o = new Float32Array(n);
  const hp = new SVF(); hp.set(5500, 0.8);
  const lp = new SVF(); lp.set(11000, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    hp.proc(noise()); lp.proc(hp.hp);
    const e = (t < 0.008 ? t / 0.008 : Math.exp(-(t - 0.008) / decay));
    o[i] = lp.lp * e;
  }
  return fadeEnd(o, 5);
}

function rim({ len = 0.12 } = {}) {
  const n = Math.round(len * SR), o = new Float32Array(n);
  const bp = new SVF(); bp.set(2200, 2.5);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    bp.proc(noise());
    o[i] = (Math.sin(TAU * 1650 * t) * 0.6 + Math.sin(TAU * 480 * t) * 0.4) * Math.exp(-t / 0.012) + bp.bp * Math.exp(-t / 0.02) * 0.8;
  }
  return fadeEnd(o, 5);
}

function snap({ len = 0.25 } = {}) {
  const n = Math.round(len * SR), o = new Float32Array(n);
  const bp = new SVF(); bp.set(2600, 1.6);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    bp.proc(noise());
    o[i] = bp.bp * (Math.exp(-t / 0.018) + 0.25 * Math.exp(-t / 0.07)) * 2 + Math.sin(TAU * 1200 * t) * Math.exp(-t / 0.006) * 0.3;
  }
  return fadeEnd(o, 5);
}

function tom(freq, { decay = 0.45, len = 1.2, noiseAmt = 0.25 } = {}) {
  const n = Math.round(len * SR), o = new Float32Array(n);
  const lp = new SVF(); lp.set(900, 0.8);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (freq * (1 + 0.8 * Math.exp(-t / 0.03))) / SR;
    lp.proc(noise());
    const s = Math.sin(TAU * ph) * Math.exp(-t / decay) + lp.lp * noiseAmt * Math.exp(-t / 0.08) * 2;
    o[i] = Math.tanh(s * 1.4);
  }
  return fadeEnd(o, 10);
}

function crash({ len = 2.2, decay = 0.8, hpf = 3200 } = {}) {
  const n = Math.round(len * SR), out = stereo(n);
  const tones = Array.from({ length: 14 }, () => ({ f: rr(3000, 9500), p: rnd(), a: rr(0.2, 1) }));
  for (const ch of [out.L, out.R]) {
    const hp = new SVF(), lp = new SVF(); hp.set(hpf, 0.6); lp.set(13000, 0.7);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let m = 0;
      for (const tn of tones) m += Math.sin(TAU * (tn.f * t + tn.p)) * tn.a;
      hp.proc(noise() + m * 0.04); lp.proc(hp.hp);
      const e = (1 - Math.exp(-t / 0.002)) * (0.6 * Math.exp(-t / 0.08) + 0.4 * Math.exp(-t / decay));
      ch[i] = lp.lp * e;
    }
  }
  return fadeEndS(out, 30);
}

// ---------- tonal voices ----------

// detuned saw stack, stereo, filtered
function supersaw(freq, dur, o = {}) {
  const { voices = 7, cents = 18, cut = 2500, cutEnv = 0, cutDec = 0.3, cutRise = 0, q = 0.75, a = 0.01, d = 0.4, s = 0.8, r = 0.3, width = 0.8 } = o;
  const n = Math.round((dur + r) * SR) + 1, out = stereo(n);
  const vs = Array.from({ length: voices }, (_, v) => {
    const x = voices === 1 ? 0 : (v / (voices - 1)) * 2 - 1;
    const pa = ((x * width + 1) * Math.PI) / 4;
    const w = x === 0 ? 1 : 0.8;
    return { inc: (freq * 2 ** ((x * cents) / 1200)) / SR, p: rnd(), gl: Math.cos(pa) * w, gr: Math.sin(pa) * w };
  });
  const fL = new SVF(), fR = new SVF();
  const norm = 1.2 / Math.sqrt(voices);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if ((i & 15) === 0) {
      let c = cut + cutEnv * Math.exp(-t / cutDec);
      if (cutRise) c *= 2 ** (cutRise * Math.min(t, dur) / Math.max(dur, 0.01));
      fL.set(c, q); fR.set(c, q);
    }
    let l = 0, rr2 = 0;
    for (const v of vs) {
      v.p += v.inc; if (v.p >= 1) v.p -= 1;
      const x = blepSaw(v.p, v.inc);
      l += x * v.gl; rr2 += x * v.gr;
    }
    const e = adsr(t, dur, a, d, s, r) * norm;
    out.L[i] = fL.proc(l) * e; out.R[i] = fR.proc(rr2) * e;
  }
  return out;
}

// filtered saw pluck, mono
function pluck(freq, dur, o = {}) {
  const { cut = 700, env = 3500, fdec = 0.12, adec = 0.4, q = 0.9, cents = 7, r = 0.08, sub = 0, a = 0.002 } = o;
  const n = Math.round((dur + r) * SR) + 1, out = new Float32Array(n);
  const f = new SVF();
  let p1 = rnd(), p2 = rnd(), ps = 0;
  const i1 = (freq * 2 ** (cents / 1200)) / SR, i2 = (freq * 2 ** (-cents / 1200)) / SR;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if ((i & 7) === 0) f.set(cut + env * Math.exp(-t / fdec), q);
    p1 += i1; if (p1 >= 1) p1 -= 1;
    p2 += i2; if (p2 >= 1) p2 -= 1;
    ps += freq / 2 / SR;
    const x = (blepSaw(p1, i1) + blepSaw(p2, i2)) * 0.5;
    let e = (t < a ? t / a : 1) * Math.exp(-t / adec);
    if (t > dur) { const k = 1 - (t - dur) / r; e *= k > 0 ? k * k : 0; }
    out[i] = (f.proc(x) + Math.sin(TAU * ps) * sub) * e;
  }
  return out;
}

// karplus-strong string
function ks(freq, dur, o = {}) {
  const { t60 = 1.2, bright = 0.6, r = 0.08 } = o;
  const n = Math.round((dur + r) * SR) + 1, y = new Float32Array(n);
  const D = SR / freq;
  const g = Math.exp((Math.log(0.001) * (D / SR)) / t60);
  const exN = Math.ceil(D);
  let lpS = 0;
  const read = (x) => {
    if (x < 0) return 0;
    const i0 = Math.floor(x), fr = x - i0;
    return y[i0] + (y[i0 + 1] - y[i0]) * fr;
  };
  for (let i = 0; i < n; i++) {
    let ex = 0;
    if (i < exN) { lpS += (noise() - lpS) * bright; ex = lpS; }
    const fb = i - D + 0.5 >= 0 ? 0.5 * (read(i - D + 0.5) + read(i - D - 0.5)) : 0;
    y[i] = ex + g * fb;
  }
  // dc block and release
  let px = 0, py = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, x = y[i];
    py = x - px + 0.995 * py; px = x;
    let e = 1;
    if (t > dur) { const k = 1 - (t - dur) / r; e = k > 0 ? k * k : 0; }
    y[i] = py * e;
  }
  return y;
}

// fm electric piano
function epiano(freq, dur, vel = 0.7, o = {}) {
  const { r = 0.25, wow = 0.0015, decay } = o;
  const n = Math.round((dur + r) * SR) + 1, out = new Float32Array(n);
  const dec = decay ?? clamp(2.2 * (261.6 / freq) ** 0.4, 0.6, 4);
  const lfoP = rnd() * TAU;
  let pc = rnd(), pm = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const w = 1 + wow * Math.sin(TAU * 0.55 * t + lfoP);
    pc += (freq * w) / SR; pm += (freq * w) / SR;
    const idx = (0.9 * vel + 0.4) * Math.exp(-t / 0.45) + 0.2;
    const body = Math.sin(TAU * pc + idx * Math.sin(TAU * pm));
    const tine = Math.sin(TAU * pc + 1.2 * vel * Math.exp(-t / 0.025) * Math.sin(TAU * pm * 14)) * 0.3 * Math.exp(-t / 0.15);
    let e = (t < 0.003 ? t / 0.003 : 1) * (0.75 * Math.exp(-t / dec) + 0.25 * Math.exp(-t / (dec * 0.2)));
    if (t > dur) { const k = 1 - (t - dur) / r; e *= k > 0 ? k * k : 0; }
    out[i] = (body + tine) * e * vel;
  }
  return out;
}

// additive piano
function piano(freq, dur, vel = 0.7, o = {}) {
  const { r = 0.3 } = o;
  const n = Math.round((dur + r) * SR) + 1, out = new Float32Array(n);
  const K = Math.max(2, Math.min(12, Math.floor(9000 / freq)));
  const B = 0.00032;
  const T = clamp(3.2 * (261.6 / freq) ** 0.55, 0.7, 7);
  const bright = 0.42 + 0.35 * vel;
  const parts = [];
  for (let k = 1; k <= K; k++) {
    const fk = k * freq * Math.sqrt(1 + B * k * k);
    const amp = (bright ** (k - 1)) / k ** 0.5 * (k === 1 ? 1 : 0.8);
    const dk = T / (1 + 0.45 * (k - 1));
    parts.push({ w1: (TAU * fk) / SR, w2: (TAU * fk * 1.0006) / SR, p1: rnd() * TAU, p2: rnd() * TAU, amp, dk });
  }
  const lp = new SVF(); lp.set(2500 + 3000 * vel, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let s = 0;
    for (const p of parts) {
      const e = 0.65 * Math.exp(-t / (p.dk * 0.22)) + 0.35 * Math.exp(-t / p.dk);
      s += (Math.sin(p.w1 * i + p.p1) + Math.sin(p.w2 * i + p.p2)) * 0.5 * p.amp * e;
    }
    lp.proc(noise());
    s += lp.lp * Math.exp(-t / 0.004) * 0.3;
    let e = t < 0.002 ? t / 0.002 : 1;
    if (t > dur) { const k = 1 - (t - dur) / r; e *= k > 0 ? k * k : 0; }
    out[i] = s * e * vel * 0.5;
  }
  return out;
}

// fm bell / mallet
function bell(freq, dur, vel = 0.7, o = {}) {
  const { ratio = 3.5, index = 2.2, idec = 0.5, decay = 1.6, r = 0.3, body = 0.3, a = 0.001 } = o;
  const n = Math.round((dur + r) * SR) + 1, out = new Float32Array(n);
  let pc = 0, pm = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    pc += freq / SR; pm += (freq * ratio) / SR;
    const I = index * vel * Math.exp(-t / idec) + 0.15;
    const s = Math.sin(TAU * pc + I * Math.sin(TAU * pm)) + body * Math.sin(TAU * pc * 2.0) * Math.exp(-t / (decay * 0.5));
    let e = (t < a ? t / a : 1) * Math.exp(-t / decay);
    if (t > dur) { const k = 1 - (t - dur) / r; e *= k > 0 ? k * k : 0; }
    out[i] = s * e * vel;
  }
  return out;
}

// sine sub bass
function sub(freq, dur, o = {}) {
  const { a = 0.006, r = 0.06, drive = 1.3, h2 = 0.12, glideFrom = 0, glide = 0.04 } = o;
  const n = Math.round((dur + r) * SR) + 1, out = new Float32Array(n);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = glideFrom ? freq + (glideFrom - freq) * Math.exp(-t / glide) : freq;
    p += f / SR;
    const s = Math.sin(TAU * p) + h2 * Math.sin(2 * TAU * p);
    out[i] = (Math.tanh(s * drive) / Math.tanh(drive)) * adsr(t, dur, a, 0.3, 0.9, r);
  }
  return out;
}

// saw + sub bass
function bassSynth(freq, dur, o = {}) {
  const { cut = 350, env = 1200, fdec = 0.08, q = 1.0, subAmt = 0.7, a = 0.003, r = 0.05, s = 0.85 } = o;
  const n = Math.round((dur + r) * SR) + 1, out = new Float32Array(n);
  const f = new SVF();
  let p1 = rnd(), p2 = rnd(), ps = 0;
  const i1 = (freq * 1.004) / SR, i2 = (freq * 0.996) / SR;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    if ((i & 7) === 0) f.set(cut + env * Math.exp(-t / fdec), q);
    p1 += i1; if (p1 >= 1) p1 -= 1;
    p2 += i2; if (p2 >= 1) p2 -= 1;
    ps += freq / 2 / SR;
    const x = (blepSaw(p1, i1) + blepSaw(p2, i2)) * 0.5;
    const y = f.proc(x) + Math.sin(TAU * ps) * subAmt;
    out[i] = Math.tanh(y * 1.3) * adsr(t, dur, a, 0.15, s, r);
  }
  return out;
}

// noise + tone riser, stereo
function riser(len, o = {}) {
  const { f0 = 300, f1 = 7000, tone = true, t0 = 220, t1 = 1100, q = 1.4, curve = 2.2 } = o;
  const n = Math.round(len * SR), out = stereo(n);
  const fl = new SVF(), fr = new SVF();
  let p1 = 0, p2 = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n, t = i / SR;
    if ((i & 15) === 0) { const f = f0 * (f1 / f0) ** (x ** 1.4); fl.set(f, q); fr.set(f * 1.03, q); }
    const e = x ** curve;
    let l = fl.proc(noise()) * 0.3 + fl.bp * 0.9, r = fr.proc(noise()) * 0.3 + fr.bp * 0.9;
    if (tone) {
      const f = t0 * (t1 / t0) ** (x ** 1.6);
      p1 += f / SR; p2 += (f * 1.005) / SR;
      const ts = (Math.sin(TAU * p1) + 0.3 * Math.sin(TAU * 3 * p1)) * 0.22;
      const ts2 = (Math.sin(TAU * p2) + 0.3 * Math.sin(TAU * 3 * p2)) * 0.22;
      l += ts; r += ts2;
    }
    out.L[i] = l * e; out.R[i] = r * e;
  }
  return fadeEndS(out, 3);
}

// deep impact boom, stereo
function impact(len = 1.4, o = {}) {
  const { f0 = 90, f1 = 32, pd = 0.12, ad = 0.55, noiseAmt = 0.6 } = o;
  const n = Math.round(len * SR), out = stereo(n);
  let ph = 0;
  const lpL = new SVF(), lpR = new SVF(), mid = new SVF();
  mid.set(1800, 0.8);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (f1 + (f0 - f1) * Math.exp(-t / pd)) / SR;
    const boom = Math.tanh(Math.sin(TAU * ph) * 1.8) * (t < 0.04 ? 1 : Math.exp(-(t - 0.04) / ad));
    if ((i & 15) === 0) { const c = 200 + 5000 * Math.exp(-t / 0.06); lpL.set(c, 0.6); lpR.set(c * 1.1, 0.6); }
    const ne = Math.exp(-t / 0.35) * (1 - Math.exp(-t / 0.003));
    mid.proc(noise());
    const crack = mid.bp * Math.exp(-t / 0.015) * (1 - Math.exp(-t / 0.0015)) * 0.8;
    out.L[i] = boom + (lpL.proc(noise()) * ne + crack) * noiseAmt;
    out.R[i] = boom + (lpR.proc(noise()) * ne + crack) * noiseAmt;
  }
  return fadeEndS(out, 40);
}

// ---------- effects ----------

function freeverb(src, { fb = 0.84, damp = 0.3, width = 1, pre = 0.02 } = {}) {
  const n = src.L.length, out = stereo(n);
  const combT = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  const apT = [556, 441, 341, 225];
  const pd = Math.round(pre * SR);
  for (let ch = 0; ch < 2; ch++) {
    const sp = ch ? 23 : 0;
    const cb = combT.map((t) => ({ b: new Float32Array(t + sp), i: 0, st: 0 }));
    const ap = apT.map((t) => ({ b: new Float32Array(t + sp), i: 0 }));
    const o = ch ? out.R : out.L;
    const inp = ch ? src.R : src.L, other = ch ? src.L : src.R;
    for (let i = 0; i < n; i++) {
      const j = i - pd;
      const x = j >= 0 ? (inp[j] * 0.7 + other[j] * 0.3) * 0.03 : 0;
      let s = 0;
      for (let k = 0; k < 8; k++) {
        const c = cb[k];
        const y = c.b[c.i];
        c.st = y * (1 - damp) + c.st * damp;
        c.b[c.i] = x + c.st * fb;
        if (++c.i >= c.b.length) c.i = 0;
        s += y;
      }
      for (let k = 0; k < 4; k++) {
        const a = ap[k];
        const bo = a.b[a.i];
        a.b[a.i] = s + bo * 0.5;
        if (++a.i >= a.b.length) a.i = 0;
        s = bo - s;
      }
      o[i] = s;
    }
  }
  const w1 = width / 2 + 0.5, w2 = (1 - width) / 2;
  for (let i = 0; i < n; i++) {
    const l = out.L[i], r = out.R[i];
    out.L[i] = l * w1 + r * w2; out.R[i] = r * w1 + l * w2;
  }
  return out;
}

function pingpong(src, time, fb = 0.35, lpf = 5000) {
  const n = src.L.length, out = stereo(n);
  const d = Math.round(time * SR);
  const bl = new Float32Array(d), br = new Float32Array(d);
  const a = 1 - Math.exp((-TAU * lpf) / SR);
  let sl = 0, sr = 0, pos = 0;
  for (let i = 0; i < n; i++) {
    const xl = bl[pos], xr = br[pos];
    out.L[i] = xl; out.R[i] = xr;
    sl += (xl - sl) * a; sr += (xr - sr) * a;
    bl[pos] = (src.L[i] + src.R[i]) * 0.5 + sr * fb;
    br[pos] = sl * fb;
    if (++pos >= d) pos = 0;
  }
  return out;
}

// ---------- loudness / mastering ----------

function lufs(s) {
  const n = s.L.length;
  if (!n) return -Infinity;
  const k1 = biquad('hs', 1500, 0.7071, 4), k2 = biquad('hp', 38, 0.5);
  const L = filt(filt(Float32Array.from(s.L), k1), k2);
  const R = filt(filt(Float32Array.from(s.R), k1), k2);
  const ps = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + L[i] * L[i] + R[i] * R[i];
  const blk = Math.round(0.4 * SR), hop = Math.round(0.1 * SR);
  const zs = [];
  if (n < blk) zs.push(ps[n] / n);
  else for (let st = 0; st + blk <= n; st += hop) zs.push((ps[st + blk] - ps[st]) / blk);
  const ld = (z) => -0.691 + 10 * Math.log10(z + 1e-20);
  let g = zs.filter((z) => ld(z) > -70);
  if (!g.length) return -Infinity;
  const rel = ld(g.reduce((a, b) => a + b, 0) / g.length) - 10;
  g = g.filter((z) => ld(z) > rel);
  return ld(g.reduce((a, b) => a + b, 0) / g.length);
}

const sclip = (x, t = 0.7) => {
  const a = Math.abs(x);
  if (a <= t) return x;
  return Math.sign(x) * (t + (1 - t) * Math.tanh((a - t) / (1 - t)));
};

// 4x oversampled peak estimate per sample
const TP_TAPS = (() => {
  const h = 8, out = [];
  for (const fr of [0.25, 0.5, 0.75]) {
    const t = [];
    for (let k = -h + 1; k <= h; k++) {
      const x = k - fr;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / h);
      t.push(x === 0 ? 1 : (Math.sin(Math.PI * x) / (Math.PI * x)) * w);
    }
    out.push(t);
  }
  return out;
})();
function truePeaks(x) {
  const n = x.length, out = new Float32Array(n), h = 8;
  for (let i = 0; i < n; i++) {
    let p = Math.abs(x[i]);
    if (p > 0.3) {
      for (const taps of TP_TAPS) {
        let v = 0;
        for (let k = 0; k < taps.length; k++) { const j = i + k - h + 1; if (j >= 0 && j < n) v += x[j] * taps[k]; }
        if (Math.abs(v) > p) p = Math.abs(v);
      }
    }
    out[i] = p;
  }
  return out;
}

function limiter(s, ceil, laSec = 0.004, rel = 0.08) {
  const n = s.L.length, la = Math.round(laSec * SR);
  const need = new Float32Array(n), tgt = new Float32Array(n).fill(1);
  const tpL = truePeaks(s.L), tpR = truePeaks(s.R);
  for (let i = 0; i < n; i++) {
    const p = Math.max(tpL[i], tpR[i]);
    need[i] = p > ceil ? ceil / p : 1;
    if (need[i] < 1) for (let j = Math.max(0, i - la); j <= i; j++) if (need[i] < tgt[j]) tgt[j] = need[i];
  }
  const ca = 1 - Math.exp(-4 / la), cr = 1 - Math.exp(-1 / (rel * SR));
  let g = 1, maxRed = 1;
  for (let i = 0; i < n; i++) {
    const t = tgt[i];
    g += (t - g) * (t < g ? ca : cr);
    const gg = Math.min(g, need[i]);
    if (gg < maxRed) maxRed = gg;
    s.L[i] *= gg; s.R[i] *= gg;
  }
  return 20 * Math.log10(maxRed);
}

function fades(s, fin, fout) {
  const n = s.L.length;
  const a = Math.round(fin * SR), b = Math.round(fout * SR);
  for (let i = 0; i < a && i < n; i++) { const g = i / a; s.L[i] *= g; s.R[i] *= g; }
  for (let i = 0; i < b && i < n; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / b);
    s.L[n - 1 - i] *= g; s.R[n - 1 - i] *= g;
  }
}

function master(mix, { target = -14, ceilDb = -1.5, fadeIn = 0.004, fadeOut = 0, knee = 0.72 } = {}) {
  const n = mix.L.length, ceil = 10 ** (ceilDb / 20);
  let gain = 10 ** ((target - lufs(mix)) / 20);
  let res, meas, red = 0;
  for (let k = 0; k < 5; k++) {
    res = stereo(n);
    for (let i = 0; i < n; i++) { res.L[i] = sclip(mix.L[i] * gain, knee); res.R[i] = sclip(mix.R[i] * gain, knee); }
    red = limiter(res, ceil);
    fades(res, fadeIn, fadeOut);
    meas = lufs(res);
    if (Math.abs(meas - target) < 0.1) break;
    gain *= 10 ** ((target - meas) / 20);
  }
  return { out: res, lufs: meas, peak: 20 * Math.log10(peakOf(res)), limitDb: red };
}

function truePeakDb(s) {
  let p = 0;
  for (const ch of [s.L, s.R]) { const t = truePeaks(ch); for (let i = 0; i < t.length; i++) if (t[i] > p) p = t[i]; }
  return 20 * Math.log10(p);
}

// ---------- song scaffold ----------

function song(name, bpm, len = 32) {
  seed(name);
  const n = Math.round(len * SR);
  const beat = 60 / bpm;
  const buses = {};
  return {
    name, bpm, beat, barLen: beat * 4, n, len, buses, kicks: [],
    bus(k) { return (buses[k] ??= stereo(n)); },
    put(k, sig, t, gain = 1, pan = 0) { addMono(this.bus(k), sig, t, gain, pan); },
    putS(k, sig, t, gain = 1) { addStereo(this.bus(k), sig, t, gain); },
    kick(sig, t, gain = 1) { this.put('kick', sig, t, gain); this.kicks.push(t); },
  };
}

function duckCurve(S, rel) {
  const d = new Float32Array(S.n);
  const att = Math.round(0.003 * SR), r = Math.round(rel * SR);
  for (const tk of S.kicks) {
    const s0 = Math.round(tk * SR);
    for (let j = 0; j < att + r && s0 + j < S.n; j++) {
      const v = j < att ? j / att : 1 - smooth((j - att) / r);
      if (v > d[s0 + j]) d[s0 + j] = v;
    }
  }
  return d;
}

// cfg per bus: { lu, hp, lp, eq, duck, drive, rev, dly }
function mixSong(S, cfg, opt = {}) {
  const n = S.n, out = stereo(n), rv = stereo(n), dl = stereo(n);
  const dk = duckCurve(S, opt.duckRel ?? S.beat * 0.6);
  let anyRv = false, anyDl = false;
  const report = {};
  for (const [k, bus] of Object.entries(S.buses)) {
    const c = cfg[k];
    if (!c) throw new Error(`${S.name}: no mix cfg for bus ${k}`);
    if (c.hp) filtS(bus, biquad('hp', c.hp, 0.7));
    if (c.lp) filtS(bus, biquad('lp', c.lp, 0.7));
    for (const e of c.eq ?? []) filtS(bus, biquad(...e));
    if (c.duck) for (let i = 0; i < n; i++) { const g = 1 - c.duck * dk[i]; bus.L[i] *= g; bus.R[i] *= g; }
    if (c.drive) {
      const dr = c.drive, nrm = 1 / Math.tanh(dr);
      for (let i = 0; i < n; i++) { bus.L[i] = Math.tanh(bus.L[i] * dr) * nrm; bus.R[i] = Math.tanh(bus.R[i] * dr) * nrm; }
    }
    const l = lufs(bus);
    if (!Number.isFinite(l)) continue;
    const g = 10 ** ((c.lu - l) / 20);
    report[k] = c.lu;
    for (let i = 0; i < n; i++) {
      const L = bus.L[i] * g, R = bus.R[i] * g;
      out.L[i] += L; out.R[i] += R;
      if (c.rev) { rv.L[i] += L * c.rev; rv.R[i] += R * c.rev; }
      if (c.dly) { dl.L[i] += L * c.dly; dl.R[i] += R * c.dly; }
    }
    if (c.rev) anyRv = true;
    if (c.dly) anyDl = true;
  }
  const dry = lufs(out);
  const addRet = (ret, db, duck) => {
    const g = 10 ** ((dry + db - lufs(ret)) / 20);
    for (let i = 0; i < n; i++) {
      const dg = duck ? 1 - duck * dk[i] : 1;
      out.L[i] += ret.L[i] * g * dg; out.R[i] += ret.R[i] * g * dg;
    }
  };
  if (anyRv) {
    const r = freeverb(rv, opt.verb);
    filtS(r, biquad('hp', opt.verbHp ?? 220, 0.7));
    filtS(r, biquad('lp', opt.verbLp ?? 8000, 0.7));
    addRet(r, opt.revDb ?? -14, opt.revDuck ?? 0.3);
  }
  if (anyDl) {
    const d = pingpong(dl, opt.dlyTime ?? S.beat * 0.75, opt.dlyFb ?? 0.38, 4500);
    filtS(d, biquad('hp', 350, 0.7));
    addRet(d, opt.dlyDb ?? -16, opt.dlyDuck ?? 0.4);
  }
  filtS(out, biquad('hp', 30, 0.54));
  filtS(out, biquad('hp', 30, 1.31));
  for (const e of opt.eq ?? []) filtS(out, biquad(...e));
  filtS(out, biquad('lp', 18500, 0.7));
  return (ceilDb) => master(out, { target: opt.target ?? -14, ceilDb, fadeIn: 0.004, fadeOut: opt.fadeOut ?? 1.6 });
}

// ---------- music ----------

function trackEnergetic() {
  const S = song('energetic', 128);
  const B = S.beat, bar = S.barLen;
  const K = kick({ f0: 175, f1: 50, pd: 0.032, ad: 0.26, click: 0.55, drive: 2 });
  const CL = clap();
  const SN = snare({ tone: 210, decay: 0.12 });
  const HC = [hat({ decay: 0.03 }), hat({ decay: 0.022 }), hat({ decay: 0.04 })];
  const HO = hat({ decay: 0.12, open: true });
  const CR = crash({ len: 2.4 });
  const prog = [
    { pad: ['F#3', 'A3', 'C#4', 'F#4'], arp: ['F#4', 'A4', 'C#5', 'F#5'], root: 'F#2' },
    { pad: ['F#3', 'A3', 'D4', 'F#4'], arp: ['F#4', 'A4', 'D5', 'F#5'], root: 'D2' },
    { pad: ['E3', 'A3', 'C#4', 'E4'], arp: ['E4', 'A4', 'C#5', 'E5'], root: 'A2' },
    { pad: ['E3', 'G#3', 'B3', 'E4'], arp: ['E4', 'G#4', 'B4', 'E5'], root: 'E2' },
  ];
  const arpPat = [0, 1, 2, 1, 3, 2, 1, 2, 0, 1, 2, 3, 2, 1, 3, 2];
  for (let b = 0; b < 17; b++) {
    const ch = prog[b % 4], t0 = b * bar, last = b === 16;
    if (b === 0 || b === 8 || last) S.putS('fx', CR, t0, last ? 1 : 0.8);
    // drums
    for (let q = 0; q < 4; q++) {
      const t = t0 + q * B;
      if (last && q > 0) break;
      if (!(b === 7 && q >= 2)) S.kick(K, t);
      if (!last && b >= 2 && (q === 1 || q === 3) && !(b === 7 && q === 3)) {
        S.put('clap', CL, t, 1, 0); S.put('clap', SN, t, 0.35, 0);
      }
      if (!last) {
        for (let s = 0; s < 4; s++) {
          const v = [0.55, 0.3, 0.8, 0.3][s] * rr(0.85, 1.05);
          if (b >= 4 && s === 2) S.put('hats', HO, t + s * B / 4, 0.75, 0.15);
          else S.put('hats', HC[(s + q) % 3], t + (s * B) / 4, v, -0.2 + 0.1 * s);
        }
      }
    }
    // snare roll build
    if (b === 7) {
      for (let k = 0; k < 24; k++) {
        const tt = k < 8 ? t0 + (k * B) / 4 : t0 + 2 * B + ((k - 8) * B) / 8;
        S.put('clap', SN, tt, 0.25 + 0.75 * (k / 23) ** 1.5, 0);
      }
    }
    if (b === 6) S.putS('fx', riser(2 * bar, { f0: 400, f1: 9000, t0: 300, t1: 1500 }), t0, 0.9);
    // pad
    const cut = b < 4 ? 900 + b * 350 : b < 8 ? 2400 + (b - 4) * 350 : 4800;
    for (const nt of ch.pad) {
      const v = supersaw(hz(nt), last ? bar * 1.5 : bar, { cut, q: 0.8, a: 0.008, d: 0.6, s: 0.75, r: last ? 1.2 : 0.2, cents: 22 });
      S.putS('pad', v, t0);
    }
    // bass
    if (!last) {
      const steps = b < 8 ? [0.5, 1.5, 2.5, 3.5] : [0.25, 0.5, 0.75, 1.25, 1.5, 1.75, 2.25, 2.5, 2.75, 3.25, 3.5, 3.75];
      if (b === 7) steps.length = 2;
      for (const st of steps) {
        const len = b < 8 ? 0.42 * B : 0.2 * B;
        S.put('bass', bassSynth(hz(ch.root), len, { cut: 260, env: b < 8 ? 1100 : 1700, fdec: 0.06, q: 1.1, subAmt: 0.75 }), t0 + st * B);
      }
    } else {
      S.put('bass', sub(hz(ch.root) / 2, bar, { r: 0.8, glideFrom: hz(ch.root) }), t0);
    }
    // lead arp
    if (b >= 4 && !last) {
      const sixteen = b >= 8;
      const cnt = sixteen ? 16 : 8;
      for (let k = 0; k < cnt; k++) {
        if (b === 7 && k >= 6) break;
        const note = ch.arp[arpPat[k % 16]];
        const len = sixteen ? 0.2 * B : 0.4 * B;
        const v = pluck(hz(note) * 2, len, { cut: 500, env: sixteen ? 5200 : 2600, fdec: 0.08, adec: 0.16, q: 1.2, r: 0.06 });
        S.put('lead', v, t0 + (k * B * 4) / cnt, k % 4 === 0 ? 1 : 0.8, k % 2 ? 0.25 : -0.25);
      }
    }
  }
  return mixSong(S, {
    kick: { lu: -17 },
    clap: { lu: -23, hp: 200, rev: 0.25 },
    hats: { lu: -26, hp: 400 },
    bass: { lu: -20, lp: 2500, duck: 0.85 },
    pad: { lu: -20.5, hp: 180, duck: 0.75, rev: 0.25 },
    lead: { lu: -22, hp: 250, rev: 0.2, dly: 0.35, duck: 0.3 },
    fx: { lu: -25, hp: 150, rev: 0.4 },
  }, { revDb: -15, dlyDb: -18, verb: { fb: 0.82, damp: 0.35 }, eq: [['hs', 7000, 0.7, 2.5]] });
}

function trackUpbeatPop() {
  const S = song('upbeat-pop', 110);
  const B = S.beat, bar = S.barLen;
  const K = kick({ f0: 150, f1: 52, pd: 0.035, ad: 0.25, click: 0.4, drive: 1.6 });
  const CL = clap({ tail: 0.16, f: 1250 });
  const SN = snare({ tone: 220, decay: 0.14 });
  const SH = shaker();
  const HC = hat({ decay: 0.028 });
  const CR = crash({ len: 2.0, decay: 0.7 });
  const prog = [
    { ch: ['E4', 'G4', 'C5'], root: 'C2' },
    { ch: ['D4', 'G4', 'B4'], root: 'G1' },
    { ch: ['E4', 'A4', 'C5'], root: 'A1' },
    { ch: ['F4', 'A4', 'C5'], root: 'F1' },
  ];
  const mel = [
    [0, 'E5', 0.5], [0.5, 'G5', 0.5], [1.5, 'A5', 0.5], [2, 'G5', 1], [3, 'E5', 0.5], [3.5, 'D5', 0.5],
    [4, 'D5', 0.5], [4.5, 'E5', 0.5], [5, 'G5', 1.5], [6.5, 'D5', 0.5], [7, 'B4', 1],
    [8, 'C5', 0.5], [8.5, 'E5', 0.5], [9, 'A5', 1], [10, 'G5', 0.5], [10.5, 'E5', 0.5], [11, 'E5', 1],
    [12, 'F5', 0.5], [12.5, 'E5', 0.5], [13, 'C5', 0.5], [13.5, 'D5', 0.5], [14, 'C5', 1.5],
  ];
  const chordSteps = [0, 3, 6, 10, 12];
  const bars = 15;
  for (let b = 0; b < bars; b++) {
    const c = prog[b % 4], t0 = b * bar, last = b === bars - 1;
    if (b === 0 || b === 8) S.putS('fx', CR, t0, 0.7);
    // drums
    for (const kb of [0, 1.5, 2]) if (!(last && kb > 0)) S.kick(K, t0 + kb * B);
    if (b % 2 === 1) S.kick(K, t0 + 3.5 * B, 0.7);
    if (!last) {
      for (const q of [1, 3]) { S.put('clap', CL, t0 + q * B, 1); S.put('clap', SN, t0 + q * B, 0.3); }
      for (let s = 0; s < 16; s++) {
        S.put('perc', SH, t0 + (s * B) / 4, [0.8, 0.4, 0.6, 0.4][s % 4] * rr(0.85, 1.1), 0.35);
        if (s % 2 === 0 && b >= 4) S.put('perc', HC, t0 + (s * B) / 4, s % 4 === 2 ? 0.8 : 0.45, -0.3);
      }
    }
    // pluck chords
    for (const st of last ? [0] : chordSteps) {
      c.ch.forEach((nt, k) => {
        const v = ks(hz(nt), st === 12 ? 0.9 * B : 0.55 * B, { t60: 0.9, bright: 0.55, r: 0.06 });
        S.put('keys', v, t0 + (st * B) / 4 + k * 0.006, st === 0 ? 1 : 0.8, (k - 1) * 0.35);
      });
    }
    // soft pad bed
    if (b >= 4) for (const nt of c.ch) S.putS('pad', supersaw(hz(nt) / 2, bar, { voices: 5, cents: 14, cut: 1400, a: 0.08, s: 0.8, r: 0.3 }), t0);
    // bass
    if (!last) {
      const r = hz(c.root) * 2;
      for (const [st, oct, len] of [[0, 1, 0.9], [1, 1, 0.4], [1.5, 1, 0.4], [2, 1, 0.9], [3, 1, 0.4], [3.5, 2, 0.4]]) {
        S.put('bass', bassSynth(r * oct, len * B, { cut: 220, env: 700, fdec: 0.07, q: 0.8, subAmt: 0.9 }), t0 + st * B);
      }
    } else S.put('bass', sub(hz(c.root), 1.5 * bar, { r: 0.6 }), t0);
    // melody
    if (b >= 4 && b < 12) {
      const phraseBar = (b - 4) % 4;
      for (const [bt, nt, du] of mel) {
        if (Math.floor(bt / 4) !== phraseBar) continue;
        const tt = t0 + (bt - phraseBar * 4) * B;
        S.put('lead', bell(hz(nt), du * B, 0.8, { ratio: 4, index: 1.6, idec: 0.04, decay: 0.45, body: 0.15 }), tt, 1, 0.1);
        S.put('lead', ks(hz(nt), du * B, { t60: 0.5, bright: 0.7 }), tt, 0.5, -0.1);
      }
    }
  }
  return mixSong(S, {
    kick: { lu: -18 },
    clap: { lu: -22, hp: 250, rev: 0.3 },
    perc: { lu: -28, hp: 500 },
    keys: { lu: -20, hp: 150, rev: 0.2, dly: 0.2, duck: 0.25 },
    pad: { lu: -27, hp: 200, duck: 0.6, rev: 0.3 },
    bass: { lu: -20, lp: 2000, duck: 0.5 },
    lead: { lu: -21, hp: 300, rev: 0.25, dly: 0.25 },
    fx: { lu: -27, hp: 300 },
  }, { revDb: -14, dlyDb: -19, verb: { fb: 0.8, damp: 0.3 }, dlyTime: S.beat * 0.75 });
}

function trackChill() {
  const S = song('chill', 85);
  const B = S.beat, bar = S.barLen;
  const swing = 0.06;
  const at = (b, beat) => b * bar + (beat + ((beat * 4) % 2 === 1 ? swing : 0)) * B;
  const K = kick({ f0: 120, f1: 48, pd: 0.03, ad: 0.22, click: 0.2, drive: 1.3 });
  const SN = snare({ tone: 180, decay: 0.2, hpf: 900, lpf: 5000, bodyAmt: 0.5 });
  const HC = [hat({ decay: 0.025, hpf: 6000 }), hat({ decay: 0.035, hpf: 6000 })];
  const HO = hat({ decay: 0.1, open: true, hpf: 6000 });
  const prog = [
    { ch: ['F3', 'A3', 'C4', 'E4'], root: 'D2' },
    { ch: ['F3', 'A3', 'B3', 'E4'], root: 'G1' },
    { ch: ['E3', 'G3', 'B3', 'D4'], root: 'C2' },
    { ch: ['G3', 'B3', 'C4', 'E4'], root: 'A1' },
  ];
  const motif = [[0.5, 'E5'], [1, 'D5'], [1.5, 'C5'], [2.5, 'A4'], [6, 'G4'], [6.5, 'A4'], [7, 'C5'], [10.5, 'B4'], [11, 'C5'], [11.5, 'D5'], [12.5, 'E5'], [14, 'D5'], [14.5, 'C5']];
  const bars = 12;
  for (let b = 0; b < bars; b++) {
    const c = prog[b % 4], t0 = b * bar, last = b === bars - 1;
    // drums
    const kpat = b % 2 === 0 ? [0, 1.75, 2.5] : [0, 0.75, 2.5, 3.25];
    for (const k of kpat) if (!(last && k > 0)) S.kick(K, at(b, k), k === 0 ? 1 : 0.8);
    if (!last) {
      for (const q of [1, 3]) S.put('drums', SN, at(b, q), 0.9 * rr(0.9, 1));
      for (let s = 0; s < 8; s++) {
        const bt = s / 2;
        if (s === 7 && b % 4 === 3) S.put('hats', HO, at(b, bt), 0.6, 0.2);
        else S.put('hats', HC[s % 2], at(b, bt), (s % 2 ? 0.45 : 0.75) * rr(0.8, 1.1), 0.2);
      }
      if (b % 2 === 1) S.put('hats', HC[0], at(b, 3.25), 0.35, 0.2);
    }
    // rhodes chords
    const vel = 0.65;
    c.ch.forEach((nt, k) => {
      S.put('keys', epiano(hz(nt), last ? bar * 1.2 : 2.7 * B, vel * rr(0.9, 1.05), { r: 0.3 }), t0 + k * 0.012, 1, (k - 1.5) * 0.25);
      if (!last) S.put('keys', epiano(hz(nt), 1.2 * B, vel * 0.7, { r: 0.25 }), at(b, 2.75) + k * 0.01, 0.75, (k - 1.5) * 0.25);
    });
    // bass
    const r = hz(c.root);
    S.put('bass', sub(r, last ? bar : 2.3 * B, { a: 0.015, r: last ? 0.6 : 0.12, drive: 1.1 }), t0);
    if (!last) S.put('bass', sub(r, 1.35 * B, { a: 0.015, r: 0.12, drive: 1.1 }), at(b, 2.5), 0.85);
    // motif
    if (b >= 4 && b < 11) {
      const ph = (b - 4) % 4;
      for (const [bt, nt] of motif) {
        if (Math.floor(bt / 4) !== ph) continue;
        S.put('lead', bell(hz(nt), 0.6 * B, 0.55, { ratio: 1, index: 1.2, idec: 0.2, decay: 0.9, body: 0.1 }), at(b, bt - ph * 4), 1, 0.3);
      }
    }
  }
  // vinyl crackle and hiss
  const vb = S.bus('vinyl');
  const hp = new SVF(); hp.set(1500, 0.7);
  const hs = new SVF(); hs.set(5000, 0.7);
  for (let i = 0; i < S.n; i++) {
    let x = 0;
    if (rnd() < 0.00035) x = noise() * rr(0.3, 1);
    hp.proc(x); hs.proc(noise());
    const v = hp.hp + hs.lp * 0.015;
    vb.L[i] = v; vb.R[i] = v * 0.7 + hs.lp * 0.004;
  }
  return mixSong(S, {
    kick: { lu: -19, lp: 3000 },
    drums: { lu: -24, lp: 4500, rev: 0.25 },
    hats: { lu: -30, lp: 7000, hp: 500 },
    keys: { lu: -19, lp: 5000, hp: 100, rev: 0.3, duck: 0.15 },
    bass: { lu: -21, lp: 300, duck: 0.35 },
    lead: { lu: -24, lp: 6000, rev: 0.4, dly: 0.3 },
    vinyl: { lu: -42 },
  }, { revDb: -13, dlyDb: -20, verb: { fb: 0.84, damp: 0.5 }, eq: [['lp', 11000, 0.7], ['ls', 200, 0.7, 1.5]], dlyTime: S.beat * 0.75 });
}

function trackCorporate() {
  const S = song('corporate', 100);
  const B = S.beat, bar = S.barLen;
  const K = kick({ f0: 140, f1: 50, pd: 0.035, ad: 0.25, click: 0.3, drive: 1.4 });
  const CL = clap({ tail: 0.12 });
  const SN = snare({ tone: 200, decay: 0.14, bodyAmt: 0.4 });
  const SH = shaker({ decay: 0.04 });
  const HC = hat({ decay: 0.025 });
  const CR = crash({ len: 2.2, decay: 0.8 });
  const prog = [
    { arp: ['G4', 'B4', 'D5', 'G5'], lh: ['G2', 'G3'], root: 'G1', pluck: ['B5', 'D6'] },
    { arp: ['F#4', 'A4', 'D5', 'F#5'], lh: ['F#2', 'D3'], root: 'F#1', pluck: ['A5', 'D6'] },
    { arp: ['G4', 'B4', 'E5', 'G5'], lh: ['E2', 'E3'], root: 'E1', pluck: ['B5', 'E6'] },
    { arp: ['G4', 'C5', 'E5', 'G5'], lh: ['C2', 'C3'], root: 'C2', pluck: ['C6', 'E6'] },
  ];
  const pat = [0, 1, 2, 3, 2, 1, 2, 3];
  const bars = 14;
  for (let b = 0; b < bars; b++) {
    const c = prog[b % 4], t0 = b * bar, last = b === bars - 1;
    if (b === 0 || b === 8) S.putS('fx', CR, t0, b ? 0.7 : 0.4);
    // drums
    S.kick(K, t0);
    if (!last) {
      S.kick(K, t0 + 2 * B);
      if (b % 2 === 1) S.kick(K, t0 + 2.5 * B, 0.6);
      if (b >= 2) for (const q of [1, 3]) { S.put('snare', CL, t0 + q * B, 0.8); S.put('snare', SN, t0 + q * B, 0.5); }
      for (let s = 0; s < 8; s++) S.put('perc', SH, t0 + (s * B) / 2, s % 2 ? 0.55 : 0.8, 0.3);
      if (b >= 8) for (let s = 0; s < 16; s++) S.put('perc', HC, t0 + (s * B) / 4, s % 2 ? 0.25 : 0.45, -0.3);
    }
    // piano
    const pv = b >= 8 ? 0.8 : 0.7;
    if (!last) {
      for (let s = 0; s < 8; s++) {
        S.put('piano', piano(hz(c.arp[pat[s]]), 0.9 * B, pv * (s % 2 ? 0.8 : 1) * rr(0.92, 1.03), { r: 0.25 }), t0 + (s * B) / 2, 1, 0.15);
      }
    } else for (const nt of c.arp) S.put('piano', piano(hz(nt), bar, pv), t0, 1, 0.15);
    for (const nt of c.lh) S.put('piano', piano(hz(nt), last ? bar : 1.9 * B, 0.7), t0, 0.8, -0.15);
    if (!last) for (const nt of c.lh) S.put('piano', piano(hz(nt), 1.9 * B, 0.6), t0 + 2 * B, 0.65, -0.15);
    // bass
    const r = hz(c.root) * 2;
    if (!last) {
      for (const [st, len] of [[0, 1.4], [1.5, 0.45], [2, 0.9], [3, 0.45], [3.5, 0.45]]) {
        S.put('bass', bassSynth(r, len * B, { cut: 180, env: 400, fdec: 0.1, q: 0.7, subAmt: 1.1 }), t0 + st * B);
      }
    } else S.put('bass', sub(r, bar, { r: 0.6 }), t0);
    // pluck counter line
    if (b >= 4 && !last) {
      for (let s = 0; s < 8; s++) {
        if (s % 2 === 0) continue;
        const nt = c.pluck[(s >> 1) % 2];
        S.put('pluck', pluck(hz(nt), 0.3 * B, { cut: 900, env: 3000, fdec: 0.06, adec: 0.18, q: 0.9 }), t0 + (s * B) / 2, 1, s % 4 === 1 ? -0.4 : 0.4);
      }
    }
    // pad
    if (b >= 8) {
      for (const nt of [c.arp[0], c.arp[1], c.arp[2]]) S.putS('pad', supersaw(hz(nt) / 2, bar, { voices: 5, cents: 12, cut: 1600, a: 0.3, s: 0.9, r: 0.5 }), t0);
    }
  }
  return mixSong(S, {
    kick: { lu: -20 },
    snare: { lu: -24, hp: 200, rev: 0.25 },
    perc: { lu: -29, hp: 500 },
    piano: { lu: -18, hp: 60, rev: 0.25, eq: [['peak', 300, 1, -2], ['hs', 5000, 0.7, 2]] },
    bass: { lu: -21, lp: 900, duck: 0.4 },
    pluck: { lu: -25, hp: 400, rev: 0.25, dly: 0.4 },
    pad: { lu: -27, hp: 250, rev: 0.3, duck: 0.3 },
    fx: { lu: -28, hp: 300 },
  }, { revDb: -14, dlyDb: -19, verb: { fb: 0.83, damp: 0.3 }, dlyTime: S.beat * 0.75 });
}

function trackCinematic() {
  const S = song('cinematic', 90);
  const B = S.beat, bar = S.barLen;
  const prog = [
    ['D3', 'F3', 'A3', 'D2'], ['D3', 'F3', 'Bb3', 'Bb1'], ['C#3', 'E3', 'A3', 'A1'],
    ['D3', 'F3', 'A3', 'D2'], ['D3', 'F3', 'Bb3', 'Bb1'], ['C3', 'F3', 'A3', 'F1'], ['C3', 'E3', 'G3', 'C2'],
    ['D3', 'G3', 'Bb3', 'G1'], ['C#3', 'E3', 'A3', 'A1'],
    ['D3', 'F3', 'A3', 'D2'], ['D3', 'F3', 'Bb3', 'Bb1'], ['D3', 'F3', 'A3', 'D2'],
  ];
  const hits = [3, 9];
  const TOM_L = tom(hz('D2'), { decay: 0.5 }), TOM_M = tom(hz('A2'), { decay: 0.35 }), TOM_H = tom(hz('D3'), { decay: 0.25 });
  const SN = snare({ tone: 180, decay: 0.2, hpf: 1000 });
  const CR = crash({ len: 3.5, decay: 1.4, hpf: 2500 });
  const REV = reverseS(crash({ len: 2.0, decay: 1.2, hpf: 2500 }));
  for (let b = 0; b < 12; b++) {
    const ch = prog[b], t0 = b * bar, isHit = hits.includes(b);
    const sec = b < 3 ? 0 : b < 9 ? 1 : 2;
    // downbeat and hits
    if (b === 0) {
      S.putS('hit', impact(2.5, { f0: 70, f1: 30, ad: 0.9, noiseAmt: 0.25 }), 0, 0.6);
      S.put('drums', TOM_L, 0, 1, -0.1);
    }
    if (isHit) {
      S.putS('hit', impact(3, { f0: 95, f1: 30, ad: 1.0, noiseAmt: 0.6 }), t0, 1);
      S.putS('fx', CR, t0, 1);
      S.put('drums', TOM_L, t0, 1, -0.1); S.put('drums', TOM_M, t0, 0.7, 0.2);
      S.putS('fx', REV, t0 - REV.L.length / SR, 0.7);
      for (const nt of ch.slice(0, 3)) S.putS('brass', supersaw(hz(nt), 1.5 * bar, { voices: 5, cents: 10, cut: 500, cutEnv: 2500, cutDec: 0.6, q: 0.9, a: 0.02, d: 0.8, s: 0.7, r: 1.0 }), t0);
      S.putS('brass', supersaw(hz(ch[3]) * 2, 1.5 * bar, { voices: 3, cents: 8, cut: 400, cutEnv: 1500, cutDec: 0.6, a: 0.02, r: 1.0 }), t0);
    }
    // pads
    for (const nt of ch.slice(0, 3)) {
      S.putS('pad', supersaw(hz(nt), bar, { voices: 7, cents: 16, cut: sec === 0 ? 700 + b * 250 : 1600, q: 0.7, a: b === 0 ? 0.05 : 0.5, d: 1, s: 0.9, r: 1.2 }), t0);
      S.putS('pad', supersaw(hz(nt) * 2, bar, { voices: 5, cents: 10, cut: 2500, q: 0.6, a: 0.8, s: 1, r: 1.2 }), t0, sec === 0 ? 0.15 : 0.35);
    }
    S.put('sub', sub(hz(ch[3]), bar, { a: 0.05, r: 0.5, drive: 1.2 }), t0, 1);
    // string ostinato
    if (b >= 1 && b < 11) {
      const dense = b === 7 || b === 8;
      const steps = dense ? 16 : 8;
      const tones = [ch[3], ch[0], ch[2], ch[0]].map((x) => nm(x) + (nm(x) < 48 ? 12 : 0));
      for (let s = 0; s < steps; s++) {
        const nt = tones[s % 4];
        const v = (sec === 0 ? 0.5 + 0.2 * b : 1) * (s % 2 ? 0.75 : 1);
        S.putS('str', supersaw(mtof(nt), (bar / steps) * 0.6, { voices: 3, cents: 9, cut: 1100, cutEnv: 1500, cutDec: 0.05, q: 0.8, a: 0.005, d: 0.08, s: 0.6, r: 0.06 }), t0 + (s * bar) / steps, v);
      }
    }
    // taiko pattern
    if (sec >= 1 && b < 11) {
      const build = b === 7 || b === 8;
      const pat = build ? [0, 2, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15] : [0, 3, 6, 8, 11, 12, 14];
      for (const s of pat) {
        const tt = t0 + (s * B) / 4;
        const drum = s % 4 === 0 ? TOM_L : s % 3 === 0 ? TOM_M : TOM_H;
        S.put('drums', drum, tt, build ? 0.55 + 0.45 * ((b - 7) * 16 + s) / 31 : 0.8, s % 2 ? 0.3 : -0.3);
      }
      if (!build) for (const q of [1, 3]) S.put('drums', SN, t0 + q * B, 0.45, 0);
    }
    if (b === 8) for (let k = 0; k < 16; k++) S.put('drums', SN, t0 + 2 * B + (k * B) / 8, 0.15 + 0.8 * (k / 15) ** 2, 0);
    // risers into hits
    if (b === 1) S.putS('fx', riser(2 * bar, { f0: 200, f1: 6000, t0: 150, t1: 900 }), t0, 0.8);
    if (b === 7) S.putS('fx', riser(2 * bar, { f0: 200, f1: 8000, t0: 150, t1: 1200 }), t0, 1);
    // bell motif in outro
    if (b >= 9) {
      const mel = [[0, 'A5'], [1.5, 'D6'], [3, 'F6']];
      for (const [bt, nt] of mel) S.put('bell', bell(hz(nt), 1.5 * B, 0.6, { ratio: 3.5, index: 1.4, decay: 1.6 }), t0 + bt * B, 1, bt - 1.5);
    }
  }
  return mixSong(S, {
    hit: { lu: -17, rev: 0.2 },
    drums: { lu: -20, rev: 0.35, hp: 40 },
    pad: { lu: -20, hp: 120, rev: 0.4 },
    brass: { lu: -21, hp: 100, rev: 0.4 },
    sub: { lu: -22, lp: 200 },
    str: { lu: -23, hp: 120, rev: 0.3 },
    fx: { lu: -23, hp: 150, rev: 0.4 },
    bell: { lu: -25, hp: 400, rev: 0.6, dly: 0.3 },
  }, { revDb: -9, dlyDb: -20, verb: { fb: 0.88, damp: 0.35, pre: 0.03 }, revDuck: 0, dlyDuck: 0, fadeOut: 2.5 });
}

function trackTech() {
  const S = song('tech', 120);
  const B = S.beat, bar = S.barLen;
  const K = kick({ f0: 160, f1: 50, pd: 0.03, ad: 0.2, len: 0.4, click: 0.5, drive: 1.8 });
  const CL = clap({ tail: 0.1, f: 1400 });
  const RM = rim();
  const HC = [hat({ decay: 0.02, hpf: 8000 }), hat({ decay: 0.03, hpf: 8000 })];
  const prog = [
    { tones: ['A3', 'E4', 'A4', 'C5', 'E5'], root: 'A1', pad: ['A3', 'C4', 'E4'] },
    { tones: ['F3', 'C4', 'F4', 'A4', 'C5'], root: 'F1', pad: ['A3', 'C4', 'F4'] },
    { tones: ['C4', 'G4', 'C5', 'E5', 'G5'], root: 'C2', pad: ['G3', 'C4', 'E4'] },
    { tones: ['G3', 'D4', 'G4', 'B4', 'D5'], root: 'G1', pad: ['G3', 'B3', 'D4'] },
  ];
  const pat = [0, 2, 1, 2, 3, 2, 1, 2, 0, 2, 1, 2, 4, 2, 1, 3];
  for (let b = 0; b < 16; b++) {
    const c = prog[Math.floor(b / 2) % 4], t0 = b * bar, last = b === 15;
    for (let q = 0; q < 4; q++) {
      const t = t0 + q * B;
      S.kick(K, t);
      if (b >= 4 && (q === 1 || q === 3)) { S.put('clap', CL, t, 0.9); S.put('clap', RM, t, 0.4); }
      if (b >= 2) S.put('hats', HC[1], t + B / 2, 0.8, 0.25);
      if (b >= 8) { S.put('hats', HC[0], t + B / 4, 0.3, -0.25); S.put('hats', HC[0], t + (3 * B) / 4, 0.4, -0.25); }
      if (b >= 6 && b % 2 === 1 && q === 3) S.put('clap', RM, t + (3 * B) / 4, 0.5, 0.4);
    }
    // arp
    const open = 500 + 3200 * (0.5 - 0.5 * Math.cos((Math.PI * b) / 8)) + (b >= 8 ? 600 : 0);
    for (let s = 0; s < 16; s++) {
      const nt = c.tones[pat[s]];
      const v = pluck(hz(nt), 0.22 * B, { cut: 250, env: open, fdec: 0.07, adec: 0.14, q: 2.2, cents: 5, sub: 0.25, r: 0.05 });
      S.put('arp', v, t0 + (s * B) / 4, s % 4 === 0 ? 1 : s % 2 ? 0.7 : 0.85, s % 2 ? 0.2 : -0.2);
    }
    // pulse bass
    for (let s = 0; s < 8; s++) {
      if (s % 2 === 0 && b < 4) continue;
      S.put('bass', bassSynth(hz(c.root) * 2, 0.4 * B, { cut: 150, env: 600, fdec: 0.05, q: 1.2, subAmt: 0.8 }), t0 + (s * B) / 2);
    }
    // pad bed
    if (b >= 8 && b % 2 === 0) for (const nt of c.pad) S.putS('pad', supersaw(hz(nt), 2 * bar, { voices: 7, cents: 15, cut: 1200, a: 0.4, s: 0.9, r: 0.6 }), t0);
    // glassy blips
    if (b >= 4 && b % 2 === 1) {
      for (const [bt, k] of [[2.5, 4], [3, 3]]) S.put('blip', bell(hz(c.tones[k]) * 2, 0.3 * B, 0.6, { ratio: 2, index: 2.5, idec: 0.05, decay: 0.35 }), t0 + bt * B, 1, k === 4 ? 0.5 : -0.5);
    }
    if (b === 7) S.putS('fx', riser(bar, { f0: 800, f1: 10000, tone: false }), t0, 0.7);
    if (b === 8) S.putS('fx', crash({ len: 2.0 }), t0, 0.5);
  }
  return mixSong(S, {
    kick: { lu: -18 },
    clap: { lu: -24, hp: 300, rev: 0.25 },
    hats: { lu: -28, hp: 600 },
    arp: { lu: -19.5, hp: 120, dly: 0.35, rev: 0.15, duck: 0.35 },
    bass: { lu: -21, lp: 800, duck: 0.8 },
    pad: { lu: -26, hp: 250, duck: 0.6, rev: 0.3 },
    blip: { lu: -26, hp: 500, rev: 0.4, dly: 0.4 },
    fx: { lu: -28, hp: 400 },
  }, { revDb: -16, dlyDb: -16, verb: { fb: 0.8, damp: 0.4 }, dlyTime: S.beat * 0.75, dlyFb: 0.42 });
}

function trackLuxury() {
  const S = song('luxury', 75);
  const B = S.beat, bar = S.barLen;
  const K = kick({ f0: 110, f1: 45, pd: 0.03, ad: 0.3, click: 0.12, drive: 1.2 });
  const SNP = snap();
  const SH = shaker({ decay: 0.05 });
  const prog = [
    { pad: ['G3', 'Bb3', 'D4', 'F4'], root: 'Eb2' },
    { pad: ['Eb3', 'G3', 'Bb3', 'D4'], root: 'C2' },
    { pad: ['Ab3', 'C4', 'Eb4', 'G4'], root: 'Ab1' },
    { pad: ['Bb3', 'Eb4', 'F4', 'Ab4'], root: 'Bb1' },
  ];
  const order = [0, 1, 2, 3, 0, 1, 2, 3, 2, 0];
  const motif = [
    [[0, 'G5'], [1.5, 'Bb5'], [3, 'D6']],
    [[0.5, 'D6'], [2, 'Bb5']],
    [[0, 'C6'], [1.5, 'Eb6'], [3, 'G5']],
    [[0.5, 'F5'], [2, 'Bb5'], [3.5, 'Ab5']],
  ];
  for (let b = 0; b < 10; b++) {
    const ci = order[b], c = prog[ci], t0 = b * bar, last = b === 9;
    // pads
    for (const nt of c.pad) S.putS('pad', supersaw(hz(nt), bar, { voices: 6, cents: 11, cut: 1300, q: 0.6, a: b === 0 ? 0.25 : 0.7, d: 1, s: 1, r: last ? 1.5 : 1.0 }), t0);
    S.put('bass', sub(hz(c.root), bar, { a: 0.03, r: 0.5, drive: 1.1 }), t0, 1);
    // piano chord on downbeat
    if (b >= 2) c.pad.forEach((nt, k) => S.put('piano', piano(hz(nt), 2.5 * B, 0.5), t0 + k * 0.02, 1, (k - 1.5) * 0.3));
    // bells
    const mot = b === 9 ? [[0, 'G5'], [1, 'Bb5'], [2, 'Eb6']] : motif[b % 4];
    for (const [bt, nt] of mot) S.put('bell', bell(hz(nt), 1.2 * B, 0.65, { ratio: 3.5, index: 1.3, idec: 0.6, decay: 1.8, body: 0.25 }), t0 + bt * B, 1, bt / 2 - 0.8);
    // light drums
    S.kick(K, t0, b === 0 ? 0.9 : 0.8);
    if (!last && b >= 1) {
      S.kick(K, t0 + 2.5 * B, 0.55);
      for (const q of [1, 3]) S.put('drums', SNP, t0 + q * B, 0.8, 0.15);
    }
    if (b >= 4 && !last) for (let s = 0; s < 8; s++) S.put('perc', SH, t0 + (s * B) / 2, s % 2 ? 0.5 : 0.75, 0.35);
  }
  return mixSong(S, {
    pad: { lu: -18.5, hp: 120, rev: 0.35, duck: 0.15 },
    bass: { lu: -22, lp: 250 },
    piano: { lu: -23, hp: 120, rev: 0.4 },
    bell: { lu: -21, hp: 400, rev: 0.5, dly: 0.3 },
    kick: { lu: -23, lp: 2500 },
    drums: { lu: -27, hp: 400, rev: 0.4 },
    perc: { lu: -31, hp: 600 },
  }, { revDb: -9, dlyDb: -19, verb: { fb: 0.9, damp: 0.45, pre: 0.03 }, revDuck: 0, dlyTime: S.beat * 1.5, dlyFb: 0.3, duckRel: 0.25, fadeOut: 2.5 });
}

// ---------- sfx ----------

function sweep(len, o = {}) {
  const { fStart = 250, fPeak = 2800, fEnd = 700, peakAt = 0.55, q = 1.1, panFrom = -0.8, panTo = 0.8, lowAmt = 0.25, envPow = 2 } = o;
  const n = Math.round(len * SR), out = stereo(n);
  const f1 = new SVF(), f2 = new SVF();
  for (let i = 0; i < n; i++) {
    const x = i / n;
    if ((i & 7) === 0) {
      const f = x < peakAt ? fStart * (fPeak / fStart) ** (x / peakAt) : fPeak * (fEnd / fPeak) ** ((x - peakAt) / (1 - peakAt));
      f1.set(f, q); f2.set(f * 0.5, 0.7);
    }
    const e = x < peakAt ? Math.sin((Math.PI / 2) * (x / peakAt)) ** envPow : (1 - (x - peakAt) / (1 - peakAt)) ** 1.6;
    f1.proc(noise()); f2.proc(noise());
    const s = (f1.bp + f2.lp * lowAmt) * e;
    const p = panFrom + (panTo - panFrom) * smooth(x);
    const a = ((p + 1) * Math.PI) / 4;
    out.L[i] = s * Math.cos(a) * Math.SQRT2; out.R[i] = s * Math.sin(a) * Math.SQRT2;
  }
  return out;
}

function withVerb(s, db = -14, opt = { fb: 0.75, damp: 0.4 }, tail = 0) {
  const n = s.L.length + Math.round(tail * SR);
  const src = stereo(n);
  addStereo(src, s, 0);
  const r = freeverb(src, opt);
  filtS(r, biquad('hp', 300, 0.7));
  const g = 10 ** ((lufs(src) + db - lufs(r)) / 20);
  for (let i = 0; i < n; i++) { src.L[i] += r.L[i] * g; src.R[i] += r.R[i] * g; }
  return src;
}

function trimTo(s, len) {
  const n = Math.round(len * SR), out = stereo(n);
  addStereo(out, s, 0);
  return out;
}

const SFX = {
  whoosh: () => trimTo(withVerb(sweep(0.6, { fStart: 300, fPeak: 3200, fEnd: 800, peakAt: 0.5, q: 1.3 }), -16), 0.6),
  'whoosh-long': () => {
    const a = sweep(1.2, { fStart: 200, fPeak: 2600, fEnd: 500, peakAt: 0.55, q: 1.0, lowAmt: 0.5 });
    const b = sweep(1.2, { fStart: 1500, fPeak: 7000, fEnd: 2500, peakAt: 0.55, q: 2, panFrom: -0.6, panTo: 0.9 });
    addStereo(a, b, 0, 0.35);
    return trimTo(withVerb(a, -15), 1.2);
  },
  'swoosh-up': () => {
    const s = sweep(0.8, { fStart: 220, fPeak: 7000, fEnd: 6000, peakAt: 0.88, q: 1.6, panFrom: -0.3, panTo: 0.3, envPow: 2.5 });
    const n = s.L.length;
    let p = 0;
    for (let i = 0; i < n; i++) {
      const x = i / n;
      p += (300 * 4 ** x) / SR;
      const e = (x < 0.88 ? (x / 0.88) ** 2 : 1 - (x - 0.88) / 0.12) * 0.12;
      const v = Math.sin(TAU * p) * e;
      s.L[i] += v; s.R[i] += v;
    }
    return trimTo(withVerb(s, -15), 0.8);
  },
  pop: () => {
    const n = Math.round(0.15 * SR), o = new Float32Array(n);
    let p = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      p += (380 + 820 * (1 - Math.exp(-t / 0.018))) / SR;
      const e = (t < 0.0015 ? t / 0.0015 : 1) * Math.exp(-t / 0.03);
      o[i] = (Math.sin(TAU * p) + 0.2 * Math.sin(2 * TAU * p)) * e + noise() * Math.exp(-t / 0.002) * 0.15;
    }
    const s = stereo(n); addMono(s, fadeEnd(o, 10), 0);
    return s;
  },
  click: () => {
    const n = Math.round(0.06 * SR), o = new Float32Array(n);
    const bp = new SVF(); bp.set(3500, 2.2);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      bp.proc(noise());
      o[i] = bp.bp * Math.exp(-t / 0.004) * 1.5 + Math.sin(TAU * 2100 * t) * Math.exp(-t / 0.005) * 0.5 + Math.sin(TAU * 140 * t) * Math.exp(-t / 0.008) * 0.4;
    }
    const s = stereo(n); addMono(s, fadeEnd(o, 10), 0);
    return s;
  },
  impact: () => {
    const s = impact(1.3, { f0: 85, f1: 30, pd: 0.1, ad: 0.45, noiseAmt: 0.7 });
    return trimTo(withVerb(s, -10, { fb: 0.82, damp: 0.5 }), 1.3);
  },
  hit: () => {
    const n = Math.round(0.4 * SR), s = stereo(n);
    addMono(s, kick({ f0: 220, f1: 70, pd: 0.02, ad: 0.08, len: 0.35, click: 0.6, drive: 2.2 }), 0, 0.9);
    addMono(s, snare({ tone: 240, decay: 0.07, hpf: 1800, len: 0.3 }), 0, 0.7);
    addMono(s, clap({ tail: 0.06, f: 1600, len: 0.25 }), 0.002, 0.4, 0.2);
    return fadeEndS(trimTo(withVerb(s, -12, { fb: 0.7, damp: 0.4 }), 0.4), 20);
  },
  riser: () => riser(2.0, { f0: 250, f1: 10000, t0: 180, t1: 1400, curve: 2.5 }),
  shimmer: () => {
    const n = Math.round(1.5 * SR), s = stereo(n);
    const notes = ['C6', 'E6', 'G6', 'A6', 'C7', 'D7', 'E7', 'G7', 'A7', 'C8'];
    for (let k = 0; k < 16; k++) {
      const nt = notes[Math.floor(rnd() * notes.length)];
      const t = (k / 16) * 0.55 + rr(0, 0.04);
      addMono(s, bell(hz(nt), 0.15, 0.5 * (1 - k / 22), { ratio: 3.5, index: 1, idec: 0.1, decay: 0.35, r: 0.3 }), t, 1, rr(-0.9, 0.9));
    }
    const hp = new SVF(); hp.set(9000, 0.7);
    for (let i = 0; i < n; i++) {
      const x = i / n;
      hp.proc(noise());
      const e = Math.sin(Math.PI * Math.min(1, x * 1.6)) * 0.04;
      s.L[i] += hp.hp * e; s.R[i] += hp.hp * e * 0.8;
    }
    return fadeEndS(trimTo(withVerb(s, -8, { fb: 0.85, damp: 0.2 }), 1.5), 200);
  },
  ding: () => {
    const n = Math.round(1.0 * SR), o = new Float32Array(n);
    const f = hz('E6');
    const parts = [[1, 1, 0.9], [2.0, 0.3, 0.5], [2.76, 0.35, 0.35], [5.4, 0.12, 0.15], [8.93, 0.05, 0.06]];
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      for (const [r, a, d] of parts) v += Math.sin(TAU * f * r * t + 0.6 * Math.exp(-t / 0.05) * Math.sin(TAU * f * r * 3 * t)) * a * Math.exp(-t / d);
      o[i] = v * (t < 0.001 ? t / 0.001 : 1);
    }
    const s = stereo(n); addMono(s, fadeEnd(o, 60), 0);
    return trimTo(withVerb(s, -14, { fb: 0.8, damp: 0.3 }), 1.0);
  },
  glitch: () => {
    const n = Math.round(0.4 * SR), s = stereo(n);
    let i = 0, last = null;
    while (i < n) {
      const len = Math.round(rr(0.015, 0.05) * SR);
      const mode = rnd();
      let seg;
      if (last && mode < 0.35) seg = last;
      else {
        seg = new Float32Array(len);
        const f = rr(200, 2400), hold = Math.floor(rr(2, 12)), bits = Math.floor(rr(3, 6));
        let h = 0, p = 0;
        const nz = mode > 0.75;
        for (let k = 0; k < len; k++) {
          p += f / SR;
          if (k % hold === 0) h = nz ? noise() : Math.sin(TAU * p) + 0.5 * Math.sin(TAU * p * 2.01);
          const q = 2 ** bits;
          seg[k] = Math.round(h * 0.6 * q) / q;
        }
      }
      last = seg;
      const pan = rr(-0.7, 0.7), g = rr(0.5, 1);
      const m = Math.min(seg.length, n - i);
      const tmp = new Float32Array(m);
      for (let k = 0; k < m; k++) tmp[k] = seg[k] * (k < 40 ? k / 40 : 1) * (k > m - 40 ? (m - k) / 40 : 1);
      addMono(s, tmp, i / SR, g, pan);
      i += m + (rnd() < 0.3 ? Math.round(rr(0.005, 0.02) * SR) : 0);
    }
    filtS(s, biquad('hp', 120, 0.7));
    filtS(s, biquad('lp', 9000, 0.7));
    return fadeEndS(s, 20);
  },
  'bass-drop': () => {
    const n = Math.round(1.0 * SR), o = new Float32Array(n);
    let p = 0;
    const lp = new SVF(); lp.set(300, 0.7);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      p += (30 + 130 * Math.exp(-t / 0.22)) / SR;
      const e = (t < 0.005 ? t / 0.005 : 1) * (t < 0.5 ? 1 : Math.exp(-(t - 0.5) / 0.18));
      lp.proc(noise());
      o[i] = Math.tanh((Math.sin(TAU * p) + 0.25 * Math.sin(2 * TAU * p)) * 2) * e + lp.lp * Math.exp(-t / 0.05) * 0.5;
    }
    const s = stereo(n); addMono(s, fadeEnd(o, 40), 0);
    return s;
  },
  typing: () => {
    const n = Math.round(1.0 * SR), s = stereo(n);
    const key = (bright) => {
      const m = Math.round(0.05 * SR), o = new Float32Array(m);
      const bp = new SVF(); bp.set(bright, 1.8);
      for (let i = 0; i < m; i++) {
        const t = i / SR;
        bp.proc(noise());
        o[i] = bp.bp * Math.exp(-t / 0.005) * 1.6 + Math.sin(TAU * 230 * t) * Math.exp(-t / 0.007) * 0.35;
      }
      return fadeEnd(o, 5);
    };
    let t = 0.01;
    while (t < 0.92) {
      const g = rr(0.55, 1);
      addMono(s, key(rr(2800, 4500)), t, g, rr(-0.3, 0.3));
      addMono(s, key(rr(1800, 2600)), t + rr(0.035, 0.05), g * 0.3, rr(-0.3, 0.3));
      t += rr(0.06, 0.13) * (rnd() < 0.12 ? 1.8 : 1);
    }
    return fadeEndS(trimTo(withVerb(s, -20, { fb: 0.6, damp: 0.5 }), 1.0), 30);
  },
  'transition-swish': () => {
    const a = sweep(0.5, { fStart: 1200, fPeak: 6500, fEnd: 1500, peakAt: 0.35, q: 1.4, panFrom: 0.8, panTo: -0.8, lowAmt: 0.15 });
    return trimTo(withVerb(a, -16), 0.5);
  },
};

// returns a mastering fn taking the ceiling
function finishSfx(s, id) {
  filtS(s, biquad('hp', id === 'impact' || id === 'bass-drop' ? 25 : 40, 0.7));
  filtS(s, biquad('lp', 18500, 0.7));
  return (ceilDb) => {
    const ceil = 10 ** (ceilDb / 20);
    const l = lufs(s);
    // up to 3 dB of limiting, aim near -12 LUFS
    const g = Math.min(10 ** ((-12 - l) / 20), (ceil / 10 ** (truePeakDb(s) / 20)) * 10 ** (3 / 20));
    const out = stereo(s.L.length);
    for (let i = 0; i < s.L.length; i++) { out.L[i] = sclip(s.L[i] * g, 0.75); out.R[i] = sclip(s.R[i] * g, 0.75); }
    const red = limiter(out, ceil, 0.002, 0.05);
    fades(out, 0.001, Math.min(0.015, s.L.length / SR / 10));
    return { out, lufs: lufs(out), peak: truePeakDb(out), limitDb: red };
  };
}

// ---------- io ----------

function writeWav(path, s) {
  const n = s.L.length;
  const data = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { data[2 * i] = s.L[i]; data[2 * i + 1] = s.R[i]; }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + n * 8, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 8, 28); h.writeUInt16LE(8, 32); h.writeUInt16LE(32, 34);
  h.write('data', 36); h.writeUInt32LE(n * 8, 40);
  writeFileSync(path, Buffer.concat([h, Buffer.from(data.buffer)]));
}

function encode(wav, out, kbps) {
  execFileSync(FFMPEG, ['-hide_banner', '-y', '-v', 'error', '-i', wav, '-c:a', 'aac', '-b:a', `${kbps}k`, '-ar', String(SR), '-movflags', '+faststart', out]);
}

// true peak of an encoded file via ffmpeg
function measureEncoded(file) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr ?? '';
  const tail = r.slice(r.lastIndexOf('Summary:'));
  const tp = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(tail);
  return tp ? (tp[1] === '-inf' ? -Infinity : parseFloat(tp[1])) : NaN;
}

function decode(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'], { maxBuffer: 1 << 28 });
  const f = new Float32Array(new Uint8Array(r.stdout).buffer);
  const n = f.length >> 1, s = stereo(n);
  for (let i = 0; i < n; i++) { s.L[i] = f[2 * i]; s.R[i] = f[2 * i + 1]; }
  return s;
}

// local gain dips where the decoded aac overshoots
function codecDips(src, dec, target) {
  const n = src.L.length, w = Math.round(0.006 * SR);
  const tl = truePeaks(dec.L), tr = truePeaks(dec.R);
  const need = new Float32Array(n).fill(1);
  let any = false;
  for (let i = 0; i < Math.min(n, tl.length); i++) {
    const p = Math.max(tl[i], tr[i]);
    if (p <= target) continue;
    any = true;
    const g = (target / p) * 0.985;
    for (let j = Math.max(0, i - 2 * w); j <= Math.min(n - 1, i + 2 * w); j++) if (g < need[j]) need[j] = g;
  }
  if (!any) return false;
  const ps = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + need[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
    const g = (ps[b] - ps[a]) / (b - a);
    src.L[i] *= g; src.R[i] *= g;
  }
  return true;
}

// master, encode, fix codec overshoot, re-encode
function renderEncode(mastering, tmp, id, dst, kbps) {
  const r = mastering(-1.5);
  const wav = join(tmp, `${id}.wav`);
  const target = 10 ** (-1.15 / 20);
  for (let k = 0; k < 6; k++) {
    writeWav(wav, r.out);
    encode(wav, dst, kbps);
    if (!codecDips(r.out, decode(dst), target)) break;
  }
  return { ...r, tp: measureEncoded(dst) };
}

function probeDuration(file) {
  const s = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim();
  return Math.round(parseFloat(s) * 1000) / 1000;
}

// ---------- catalog ----------

const MUSIC = [
  { id: 'energetic', title: 'Energetic', bpm: 128, key: 'A major', render: trackEnergetic, mood: ['energetic', 'sport', 'sale', 'edm'], description: 'Driving four-on-the-floor EDM pop with pumping supersaw chords, rolling bass, a snare-roll build and a bright pluck arp drop around 15s.' },
  { id: 'upbeat-pop', title: 'Upbeat Pop', bpm: 110, key: 'C major', render: trackUpbeatPop, mood: ['happy', 'upbeat', 'playful', 'lifestyle'], description: 'Happy, bouncy pop with plucked guitar-like chords, claps, shaker and a catchy mallet melody.' },
  { id: 'chill', title: 'Chill', bpm: 85, key: 'C major', render: trackChill, mood: ['chill', 'lofi', 'relaxed', 'cozy'], description: 'Mellow lo-fi groove with warm electric piano chords, swung soft drums, round sub bass and light vinyl crackle.' },
  { id: 'corporate', title: 'Corporate', bpm: 100, key: 'G major', render: trackCorporate, mood: ['corporate', 'optimistic', 'clean', 'business'], description: 'Clean, optimistic piano arpeggios over light drums and bass, with plucks and a soft pad lifting the second half.' },
  { id: 'cinematic', title: 'Cinematic', bpm: 90, key: 'D minor', render: trackCinematic, mood: ['cinematic', 'epic', 'dramatic', 'trailer'], description: 'Epic trailer build: pads, string ostinato and taiko toms, risers into big impact hits at 8s and 24s.' },
  { id: 'tech', title: 'Tech', bpm: 120, key: 'A minor', render: trackTech, mood: ['tech', 'modern', 'product', 'minimal'], description: 'Minimal, modern product-launch groove with a pulsing filtered synth arp, tight kick, pulse bass and glassy blips.' },
  { id: 'luxury', title: 'Luxury', bpm: 75, key: 'Eb major', render: trackLuxury, mood: ['luxury', 'elegant', 'premium', 'calm'], description: 'Slow, elegant and spacious: warm pads, soft piano and sparse bell motifs over a gentle pulse.' },
];

const SFX_META = [
  ['whoosh', 'Whoosh', ['transition', 'movement'], 'Filtered noise sweep panning left to right.'],
  ['whoosh-long', 'Whoosh Long', ['transition', 'movement'], 'Longer, fuller airy whoosh with low body and high air.'],
  ['swoosh-up', 'Swoosh Up', ['transition', 'rise', 'reveal'], 'Rising airy swoosh with a soft tonal lift.'],
  ['pop', 'Pop', ['ui', 'appear', 'bubble'], 'Short bubbly pop for elements appearing.'],
  ['click', 'Click', ['ui', 'button'], 'Crisp UI click.'],
  ['impact', 'Impact', ['hit', 'boom', 'reveal'], 'Deep cinematic boom with sub and noise tail.'],
  ['hit', 'Hit', ['hit', 'accent'], 'Snappy punchy accent hit.'],
  ['riser', 'Riser', ['build', 'tension', 'transition'], 'Noise and tone rising to a hard cut.'],
  ['shimmer', 'Shimmer', ['sparkle', 'magic', 'reveal'], 'Sparkly high bell cascade with airy tail.'],
  ['ding', 'Ding', ['notification', 'success', 'ui'], 'Bright notification bell.'],
  ['glitch', 'Glitch', ['digital', 'tech', 'transition'], 'Digital stutter with bit-crushed slices.'],
  ['bass-drop', 'Bass Drop', ['drop', 'boom', 'hit'], 'Sub bass pitch drop.'],
  ['typing', 'Typing', ['keyboard', 'tech', 'ui'], 'Short burst of keyboard ticks.'],
  ['transition-swish', 'Transition Swish', ['transition', 'fast'], 'Fast high swish panning right to left.'],
];

// ---------- main ----------

function main() {
  const only = (() => {
    const i = process.argv.indexOf('--only');
    return i > 0 ? new Set(process.argv[i + 1].split(',')) : null;
  })();
  mkdirSync(join(OUT, 'music'), { recursive: true });
  mkdirSync(join(OUT, 'sfx'), { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'mf-audio-'));
  const manifestPath = join(OUT, 'manifest.json');
  const manifest = { license: 'CC0-1.0', generator: 'scripts/make-audio.mjs', music: [], sfx: [] };
  try {
    for (const m of MUSIC) {
      const file = `music/${m.id}.m4a`, dst = join(OUT, file);
      if (!only || only.has(m.id)) {
        const t = Date.now();
        const r = renderEncode(m.render(), tmp, m.id, dst, 192);
        console.log(`music ${m.id.padEnd(16)} ${r.lufs.toFixed(1)} LUFS  limiter ${r.limitDb.toFixed(1)} dB  aac TP ${r.tp.toFixed(1)} dBTP  ${((Date.now() - t) / 1000).toFixed(1)}s`);
      }
      if (!existsSync(dst)) { console.warn(`missing ${file}`); continue; }
      manifest.music.push({ id: m.id, file, title: m.title, bpm: m.bpm, key: m.key, duration: probeDuration(dst), mood: m.mood, description: m.description });
    }
    for (const [id, title, tags, description] of SFX_META) {
      const file = `sfx/${id}.m4a`, dst = join(OUT, file);
      if (!only || only.has(id)) {
        seed(`sfx-${id}`);
        const r = renderEncode(finishSfx(SFX[id](), id), tmp, id, dst, 160);
        console.log(`sfx   ${id.padEnd(16)} ${r.lufs.toFixed(1)} LUFS  limiter ${r.limitDb.toFixed(1)} dB  aac TP ${r.tp.toFixed(1)} dBTP`);
      }
      if (!existsSync(dst)) { console.warn(`missing ${file}`); continue; }
      manifest.sfx.push({ id, file, title, duration: probeDuration(dst), tags, description });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(OUT, 'LICENSE.txt'), [
    'MotionForge bundled audio library',
    '',
    'All music and sound effects in this directory (music/*.m4a, sfx/*.m4a) are',
    'synthesized from scratch by scripts/make-audio.mjs. No samples or third-party',
    'recordings are used.',
    '',
    'To the extent possible under law, the authors have dedicated all copyright and',
    'related and neighboring rights to these files to the public domain worldwide,',
    'under the Creative Commons CC0 1.0 Universal Public Domain Dedication.',
    'They are distributed without any warranty.',
    '',
    'Full legal text: https://creativecommons.org/publicdomain/zero/1.0/legalcode',
    '',
  ].join('\n'));
  let total = 0;
  for (const e of [...manifest.music, ...manifest.sfx]) total += statSync(join(OUT, e.file)).size;
  console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB`);
}

main();
