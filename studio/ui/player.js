// Drives the sandboxed stage frame and plays the audio tracks in sync.
import {blob} from './api.js';
import {timeline} from '../engine/schema.js';

export class Player {
  constructor() {
    this.frame = null; this.comp = null; this.projectId = null; this.t = 0; this.playing = false;
    this.listeners = new Set(); this.sent = new Set(); this.ready = false;
    this.buffers = new Map(); this.sources = []; this.ac = null; this.library = null; this.loop = false;
    this.seq = 0; this.waiters = new Map(); this.onPick = null; this.onDrag = null; this.onError = null; this.editable = true;
    addEventListener('message', e => this.onMessage(e));
  }
  attach(frame) {
    if (this.frame === frame) return;
    this.frame = frame; this.ready = false;
  }
  onMessage(e) {
    if (!this.frame || e.source !== this.frame.contentWindow || e.data?.source !== 'mf-stage') return;
    const m = e.data;
    if (m.type === 'hello') { this.ready = true; this.sent.clear(); if (this.comp) this.load(this.comp, this.projectId, true); }
    if (m.type === 'pick') this.onPick?.(m.layerId);
    if (m.type === 'drag') this.onDrag?.(m);
    if (m.type === 'error') this.onError?.(m.message);
    if (this.waiters.has(m.id)) { this.waiters.get(m.id)(); this.waiters.delete(m.id); }
  }
  post(msg) { if (this.ready && this.frame?.contentWindow) this.frame.contentWindow.postMessage(msg, '*'); }
  call(msg) { return new Promise(res => { const id = ++this.seq; this.waiters.set(id, res); this.post({...msg, id}); setTimeout(res, 4000); }); }
  get duration() { return this.comp ? timeline(this.comp).total : 0; }
  async load(comp, projectId, force = false) {
    const changedProject = projectId !== this.projectId;
    this.comp = comp; this.projectId = projectId;
    if (changedProject) { this.sent.clear(); this.buffers.clear(); this.t = 0; }
    if (this.t > this.duration) this.t = 0;
    if (!this.ready) return;
    const need = new Set();
    comp.scenes.forEach(s => s.layers.forEach(l => { if (l.type === 'image' && l.src?.startsWith('asset:')) need.add(l.src.slice(6)); if (l.type === 'ui') for (const m of `${l.html} ${l.css}`.matchAll(/asset:([A-Za-z0-9._-]+)/g)) need.add(m[1]); }));
    const assets = {};
    for (const n of need) {
      if (this.sent.has(n) && !force) continue;
      try { assets[n] = await blob(`/projects/${projectId}/assets/${encodeURIComponent(n)}`); this.sent.add(n); } catch {}
    }
    if (Object.keys(assets).length) this.post({type: 'assets', assets});
    await this.call({type: 'load', comp, fit: true, editable: this.editable});
    this.post({type: 'seek', t: this.t});
    if (this.playing) this.startAudio();
    this.emit();
  }
  select(layerId) { this.post({type: 'select', layerId}); }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this.t, this.playing); }
  seek(t) {
    this.t = Math.max(0, Math.min(t, Math.max(0, this.duration - 1e-3)));
    if (this.playing) { this.clock = {wall: performance.now(), t: this.t}; this.startAudio(); }
    this.post({type: 'seek', t: this.t});
    this.emit();
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  async play() {
    if (!this.comp?.scenes.length) return;
    if (this.t >= this.duration - 0.05) this.t = 0;
    this.playing = true;
    this.ac ||= new AudioContext();
    if (this.ac.state === 'suspended') await this.ac.resume();
    this.clock = {wall: performance.now(), t: this.t};
    this.startAudio();
    const tick = () => {
      if (!this.playing) return;
      const t = this.clock.t + (performance.now() - this.clock.wall) / 1000;
      if (t >= this.duration) {
        if (this.loop) { this.t = 0; this.clock = {wall: performance.now(), t: 0}; this.startAudio(); }
        else { this.t = Math.max(0, this.duration - 1e-3); this.post({type: 'seek', t: this.t}); this.pause(); return; }
      } else this.t = t;
      this.post({type: 'seek', t: this.t});
      this.emit();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    this.emit();
  }
  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.stopAudio();
    this.emit();
  }
  async buffer(src) {
    if (this.buffers.has(src)) return this.buffers.get(src);
    const p = (async () => {
      let data;
      if (src.startsWith('asset:')) data = await (await blob(`/projects/${this.projectId}/assets/${encodeURIComponent(src.slice(6))}`)).arrayBuffer();
      else {
        const [, kind, id] = src.match(/^lib:(music|sfx)\/(.+)$/) || [];
        const item = this.library?.[kind]?.find(x => x.id === id);
        if (!item) return null;
        data = await (await fetch(`/audio/${item.file}`)).arrayBuffer();
      }
      this.ac ||= new AudioContext();
      return this.ac.decodeAudioData(data);
    })().catch(() => null);
    this.buffers.set(src, p);
    return p;
  }
  stopAudio() { this.audioGen = (this.audioGen || 0) + 1; for (const s of this.sources) { try { s.stop(); } catch {} } this.sources = []; }
  async startAudio() {
    this.stopAudio();
    if (!this.comp || !this.ac) return;
    const gen = this.audioGen;
    const clips = this.comp.audio.filter(c => !c.muted);
    const bufs = await Promise.all(clips.map(c => this.buffer(c.src)));
    if (gen !== this.audioGen || !this.playing) return;
    const elapsed = (performance.now() - this.clock.wall) / 1000;
    const t0 = this.clock.t + elapsed, now = this.ac.currentTime + 0.02, total = this.duration;
    clips.forEach((c, i) => {
      const buf = bufs[i];
      if (!buf) return;
      const len = Math.min(c.duration ?? buf.duration - c.offset, buf.duration - c.offset, total - c.start);
      if (len <= 0 || c.start + len <= t0) return;
      const into = Math.max(0, t0 - c.start);
      const when = now + Math.max(0, c.start - t0);
      const src = this.ac.createBufferSource();
      src.buffer = buf;
      const g = this.ac.createGain();
      const at = x => when + (x - into);
      const v = c.volume;
      const level = x => v * Math.min(c.fadeIn > 0 ? x / c.fadeIn : 1, c.fadeOut > 0 ? (len - x) / c.fadeOut : 1, 1);
      g.gain.setValueAtTime(Math.max(0, level(into)), when);
      if (c.fadeIn > into) g.gain.linearRampToValueAtTime(v, at(c.fadeIn));
      if (c.fadeOut > 0) { const fs = Math.max(into, len - c.fadeOut); g.gain.setValueAtTime(Math.max(0, level(fs)), at(fs)); g.gain.linearRampToValueAtTime(0, at(len)); }
      src.connect(g).connect(this.ac.destination);
      src.start(when, c.offset + into, len - into);
      this.sources.push(src);
    });
  }
  async preview(src) {
    this.ac ||= new AudioContext();
    if (this.ac.state === 'suspended') await this.ac.resume();
    try { this.previewSrc?.stop(); } catch {}
    const buf = await this.buffer(src);
    if (!buf) return;
    const s = this.ac.createBufferSource();
    s.buffer = buf; s.connect(this.ac.destination); s.start(0, 0, Math.min(buf.duration, 12));
    this.previewSrc = s;
  }
  stopPreview() { try { this.previewSrc?.stop(); } catch {} this.previewSrc = null; }
}

export const player = new Player();
