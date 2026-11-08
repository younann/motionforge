// UI, cursor and effect layers.
import {ease, clamp01} from './easing.js';

let effectsModule = null;
const loadEffects = () => (effectsModule ||= import('./effects.js').catch(() => ({drawEffect: null})));

const FRAME = {
  iphone: {bezel: 0.034, radius: 0.17, screenRadius: 0.14},
  android: {bezel: 0.026, radius: 0.11, screenRadius: 0.09},
  tablet: {bezel: 0.04, radius: 0.07, screenRadius: 0.045},
  none: {bezel: 0, radius: 0.06, screenRadius: 0.06},
};

// Lays out a device frame and returns {total height, screen box}.
export function deviceGeometry(L) {
  const W = L.width, vp = L.viewport;
  if (L.device === 'browser' || L.device === 'laptop') {
    const bar = W * 0.045;
    const sw = L.device === 'laptop' ? W * 0.82 : W;
    const bezel = L.device === 'laptop' ? sw * 0.025 : 0;
    const screenW = sw - bezel * 2;
    const screenH = screenW * (vp.height / vp.width);
    const lid = screenH + bar + bezel * 2;
    const base = L.device === 'laptop' ? W * 0.045 : 0;
    return {height: lid + base, screen: {x: (W - sw) / 2 + bezel, y: bezel + bar, w: screenW, h: screenH}, bar, lid, sw, bezel};
  }
  const f = FRAME[L.device] || FRAME.none;
  const bezel = W * f.bezel;
  const screenW = W - bezel * 2;
  const screenH = screenW * (vp.height / vp.width);
  return {height: screenH + bezel * 2, screen: {x: bezel, y: bezel, w: screenW, h: screenH}, f};
}

function rewriteAssets(text, resolve) {
  return text.replace(/asset:([A-Za-z0-9._-]+)/g, (m, name) => resolve(`asset:${name}`) || m);
}

export class UiView {
  constructor(L, layerRoot, inner, ctx) {
    this.L = L; this.ctx = ctx;
    const g = (this.geo = deviceGeometry(L));
    layerRoot.style.width = `${L.width}px`;
    layerRoot.style.height = `${g.height}px`;
    inner.style.cssText = 'position:absolute;inset:0';
    const W = L.width, dc = L.deviceColor;
    const frame = document.createElement('div');
    frame.style.cssText = 'position:absolute;inset:0';
    inner.append(frame);
    if (L.device === 'browser' || L.device === 'laptop') {
      const lid = document.createElement('div');
      const left = (W - g.sw) / 2;
      lid.style.cssText = `position:absolute;left:${left}px;top:0;width:${g.sw}px;height:${g.lid}px;border-radius:${W * 0.016}px;background:${L.device === 'laptop' ? dc : '#f4f4f6'};box-shadow:0 ${W * 0.04}px ${W * 0.09}px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.08);overflow:hidden`;
      const bar = document.createElement('div');
      bar.style.cssText = `position:absolute;left:${g.bezel}px;right:${g.bezel}px;top:${g.bezel}px;height:${g.bar}px;background:#ececf0;display:flex;align-items:center;gap:${W * 0.008}px;padding:0 ${W * 0.016}px;box-sizing:border-box;border-bottom:1px solid #dcdce2`;
      for (const c of ['#ff5f57', '#febc2e', '#28c840']) { const d = document.createElement('i'); d.style.cssText = `width:${W * 0.011}px;height:${W * 0.011}px;border-radius:50%;background:${c};flex:none`; bar.append(d); }
      const url = document.createElement('div');
      url.textContent = L.url || '';
      url.style.cssText = `margin-left:${W * 0.03}px;flex:1;max-width:60%;height:${g.bar * 0.56}px;border-radius:${g.bar}px;background:#fff;color:#6b6b75;font:500 ${g.bar * 0.3}px/${g.bar * 0.56}px Inter,sans-serif;padding:0 ${W * 0.012}px;overflow:hidden;white-space:nowrap`;
      bar.append(url);
      lid.append(bar);
      frame.append(lid);
      if (L.device === 'laptop') {
        const base = document.createElement('div');
        base.style.cssText = `position:absolute;left:0;right:0;top:${g.lid - 1}px;height:${g.height - g.lid}px;background:linear-gradient(#d9d9de,#9fa0a8);clip-path:polygon(4% 0,96% 0,100% 70%,98% 100%,2% 100%,0 70%);border-radius:0 0 ${W * 0.02}px ${W * 0.02}px`;
        frame.append(base);
      }
    } else if (L.device !== 'none') {
      const f = g.f;
      const body = document.createElement('div');
      body.style.cssText = `position:absolute;inset:0;border-radius:${W * f.radius}px;background:${dc};box-shadow:inset 0 0 0 ${Math.max(1.5, W * 0.006)}px rgba(255,255,255,.14), 0 ${W * 0.06}px ${W * 0.14}px rgba(0,0,0,.45)`;
      frame.append(body);
      const btn = (side, top, h) => { const b = document.createElement('div'); b.style.cssText = `position:absolute;${side}:${-W * 0.008}px;top:${top}px;width:${W * 0.01}px;height:${h}px;border-radius:${W * 0.01}px;background:${dc}`; frame.append(b); };
      if (L.device !== 'tablet') { btn('left', g.height * 0.2, g.height * 0.06); btn('left', g.height * 0.29, g.height * 0.1); btn('right', g.height * 0.25, g.height * 0.14); }
    }
    const scr = document.createElement('div');
    const sr = L.device === 'browser' || L.device === 'laptop' ? 0 : W * (g.f?.screenRadius || 0.05);
    scr.style.cssText = `position:absolute;left:${g.screen.x}px;top:${g.screen.y}px;width:${g.screen.w}px;height:${g.screen.h}px;overflow:hidden;border-radius:${sr}px;background:${L.screen};isolation:isolate`;
    frame.append(scr);
    if (L.device === 'iphone') {
      const island = document.createElement('div');
      island.style.cssText = `position:absolute;left:50%;top:${g.screen.y + g.screen.w * 0.03}px;width:${g.screen.w * 0.3}px;height:${g.screen.w * 0.085}px;margin-left:${-g.screen.w * 0.15}px;border-radius:${g.screen.w}px;background:#000;z-index:3`;
      frame.append(island);
    } else if (L.device === 'android') {
      const cam = document.createElement('div');
      cam.style.cssText = `position:absolute;left:50%;top:${g.screen.y + g.screen.w * 0.035}px;width:${g.screen.w * 0.035}px;height:${g.screen.w * 0.035}px;margin-left:${-g.screen.w * 0.0175}px;border-radius:50%;background:#000;z-index:3`;
      frame.append(cam);
    }
    // Content at design size, scaled to the screen.
    const k = g.screen.w / L.viewport.width;
    const host = document.createElement('div');
    host.style.cssText = `position:absolute;left:0;top:0;width:${L.viewport.width}px;height:${L.viewport.height}px;transform-origin:0 0;transform:scale(${k})`;
    scr.append(host);
    const shadow = host.attachShadow({mode: 'open'});
    const resolve = this.ctx.resolveAsset;
    shadow.innerHTML = `<style>:host{all:initial;visibility:inherit;display:block;width:100%;height:100%;font-family:Inter,system-ui,sans-serif;color:#111;--t:0;--p:0}*{box-sizing:border-box;transition:none!important;animation:none!important}.mf-root{position:relative;width:100%;height:100%;overflow:hidden}.mf-scroll{position:relative;min-height:100%;height:100%}.mf-caret{display:inline-block;width:.08em;height:1em;margin-left:.04em;vertical-align:-.12em;background:currentColor}${rewriteAssets(L.css, resolve)}</style><div class="mf-root"><div class="mf-scroll">${rewriteAssets(L.html, resolve)}</div></div>`;
    this.host = host; this.shadow = shadow;
    this.scroll = shadow.querySelector('[data-scroll]') || shadow.querySelector('.mf-scroll');
    this.timed = [...shadow.querySelectorAll('[data-at]')].map(el => ({
      el, at: Number(el.dataset.at) || 0, dur: Number(el.dataset.dur) || 0.45, until: el.dataset.until != null ? Number(el.dataset.until) : null,
      ease: el.dataset.ease || 'easeOutCubic',
    }));
    this.typed = [...shadow.querySelectorAll('[data-type]')].map(el => ({el, text: el.textContent, at: Number(el.dataset.at) || 0, cps: Number(el.dataset.cps) || 16, caret: el.dataset.caret !== 'false'}));
    this.counts = [...shadow.querySelectorAll('[data-count]')].map(el => ({
      el, to: Number(el.dataset.count) || 0, from: Number(el.dataset.from) || 0, at: Number(el.dataset.at) || 0, dur: Number(el.dataset.dur) || 1.2,
      decimals: Number(el.dataset.decimals) || 0, prefix: el.dataset.prefix || '', suffix: el.dataset.suffix || '',
    }));
    for (const img of shadow.querySelectorAll('img')) { img.decoding = 'sync'; this.ctx.track(img); }
  }
  update(local, kf, sample) {
    const h = this.host;
    h.style.setProperty('--t', local.toFixed(4));
    h.style.setProperty('--p', clamp01(local / Math.max(0.01, this.duration || 1)).toFixed(4));
    for (const it of this.timed) {
      let k = ease(it.ease, (local - it.at) / it.dur);
      if (it.until != null) k *= 1 - ease('easeInCubic', (local - it.until) / it.dur);
      it.el.style.setProperty('--k', k.toFixed(4));
      if (k > 0.5) it.el.setAttribute('data-on', ''); else it.el.removeAttribute('data-on');
    }
    for (const it of this.typed) {
      const n = Math.max(0, Math.min(it.text.length, Math.floor((local - it.at) * it.cps)));
      const done = n >= it.text.length;
      const blink = Math.floor(local * 2) % 2 === 0;
      it.el.innerHTML = '';
      it.el.append(document.createTextNode(it.text.slice(0, n)));
      if (it.caret && local >= it.at - 0.6 && (!done || blink) && local < it.at + it.text.length / it.cps + 1.2) {
        const c = document.createElement('span'); c.className = 'mf-caret'; it.el.append(c);
      }
    }
    for (const it of this.counts) {
      const v = it.from + (it.to - it.from) * ease('easeOutCubic', (local - it.at) / it.dur);
      it.el.textContent = `${it.prefix}${v.toLocaleString('en-US', {minimumFractionDigits: it.decimals, maximumFractionDigits: it.decimals})}${it.suffix}`;
    }
    const sc = kf.scroll ? sample(kf.scroll, local + (this.L.start || 0)) : 0;
    if (this.scroll) this.scroll.style.transform = sc ? `translateY(${(-sc).toFixed(2)}px)` : '';
  }
}

const POINTER = '<svg viewBox="0 0 32 32" width="100%" height="100%"><path d="M6 3l19 11.5-8.2 1.8 4.8 9.6-3.6 1.8-4.8-9.7L7 24z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
const HAND = '<svg viewBox="0 0 32 32" width="100%" height="100%"><path d="M12 15V6.5a2 2 0 0 1 4 0V14m0-3.5a2 2 0 0 1 4 0V15m0-2.5a2 2 0 0 1 4 0V19c0 5-3 8.5-8 8.5-3.4 0-5.2-1.5-7-4.4l-3-5a2 2 0 0 1 3.3-2.2L12 18" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';

export class CursorView {
  constructor(L, root, inner) {
    this.L = L;
    root.style.width = `${L.size}px`;
    root.style.height = `${L.size}px`;
    inner.style.cssText = 'position:absolute;inset:0';
    this.ripple = document.createElement('div');
    this.ripple.style.cssText = `position:absolute;left:50%;top:50%;width:${L.size * 1.6}px;height:${L.size * 1.6}px;margin:${-L.size * 0.8}px 0 0 ${-L.size * 0.8}px;border-radius:50%;border:${Math.max(2, L.size * 0.06)}px solid ${L.color};box-shadow:0 0 0 1px rgba(0,0,0,.25), inset 0 0 0 1px rgba(0,0,0,.2);opacity:0`;
    this.icon = document.createElement('div');
    if (L.style === 'touch') this.icon.style.cssText = `position:absolute;inset:18%;border-radius:50%;background:radial-gradient(circle at 40% 35%, rgba(255,255,255,.95), ${L.color} 60%);opacity:.78;box-shadow:0 0 0 ${Math.max(2, L.size * 0.035)}px rgba(20,20,30,.45), 0 8px 22px rgba(0,0,0,.4)`;
    else { this.icon.innerHTML = L.style === 'hand' ? HAND : POINTER; this.icon.style.cssText = 'position:absolute;inset:0;filter:drop-shadow(0 4px 8px rgba(0,0,0,.35));transform-origin:20% 10%'; }
    // Pointer tip sits at the layer's x,y.
    if (L.style !== 'touch') { root.dataset.tip = '1'; }
    inner.append(this.ripple, this.icon);
  }
  update(local, sceneTime) {
    let press = 1, rip = null;
    for (const tt of this.L.taps) {
      const d = sceneTime - tt;
      if (d >= -0.12 && d < 0.18) press = Math.min(press, 1 - 0.18 * Math.sin(clamp01((d + 0.12) / 0.3) * Math.PI));
      if (d >= 0 && d < 0.6) rip = d / 0.6;
    }
    this.icon.style.transform = press !== 1 ? `scale(${press.toFixed(3)})` : '';
    if (rip != null) {
      const e = ease('easeOutCubic', rip);
      this.ripple.style.opacity = (0.7 * (1 - rip)).toFixed(3);
      this.ripple.style.transform = `scale(${(0.25 + e * 1.1).toFixed(3)})`;
    } else this.ripple.style.opacity = '0';
  }
}

export class EffectView {
  constructor(L, root, inner, ctx) {
    this.L = L;
    root.style.width = `${L.width}px`;
    root.style.height = `${L.height}px`;
    inner.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    const c = document.createElement('canvas');
    c.width = Math.round(L.width); c.height = Math.round(L.height);
    c.style.cssText = 'width:100%;height:100%;display:block';
    inner.append(c);
    this.canvas = c; this.g = c.getContext('2d');
    const p = loadEffects().then(m => { this.draw = m.drawEffect; });
    ctx.pending.add(p); p.then(() => ctx.pending.delete(p));
  }
  update(local, duration) {
    const g = this.g, L = this.L;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.draw) return;
    try { this.draw(g, L.effect, Math.max(0, local), this.canvas.width, this.canvas.height, {colors: L.colors, density: L.density, speed: L.speed, size: L.size, seed: L.seed, duration}); } catch {}
  }
}
