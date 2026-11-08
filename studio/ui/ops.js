// Pure edit operations on a composition. Each returns a new comp.
import {uid, timeline, playable, normalizeComp, FORMATS} from '../engine/schema.js';

const clone = c => structuredClone(c);
const freshIds = scene => ({...scene, id: uid('s'), layers: scene.layers.map(l => ({...structuredClone(l), id: uid('l')}))});

export function findSceneAt(comp, t) {
  const items = timeline(comp).items;
  for (let i = items.length - 1; i >= 0; i--) if (t >= items[i].start && t < items[i].end) return items[i];
  return items[items.length - 1] || null;
}

export function splitScene(comp, t) {
  const it = findSceneAt(comp, t);
  if (!it) return comp;
  const into = (t - it.start) * it.scene.speed;
  if (into < 0.15 || it.length * it.scene.speed - into < 0.15) return comp;
  const c = clone(comp);
  const s = c.scenes[it.index];
  const local = s.trimStart + into;
  const b = freshIds(s);
  b.name = `${s.name} (2)`;
  b.trimStart = local;
  b.transition = {...s.transition, type: 'none'};
  s.trimEnd = s.duration - local;
  c.scenes.splice(it.index + 1, 0, b);
  return c;
}

export function duplicateScene(comp, id) {
  const c = clone(comp);
  const i = c.scenes.findIndex(s => s.id === id);
  if (i < 0) return comp;
  const d = freshIds(c.scenes[i]);
  d.name = `${c.scenes[i].name} copy`;
  c.scenes.splice(i + 1, 0, d);
  return c;
}

export function deleteScene(comp, id) {
  const c = clone(comp);
  c.scenes = c.scenes.filter(s => s.id !== id);
  if (c.scenes[0]) c.scenes[0].transition.type = 'none';
  return c;
}

export function moveScene(comp, id, toIndex) {
  const c = clone(comp);
  const i = c.scenes.findIndex(s => s.id === id);
  if (i < 0) return comp;
  const [s] = c.scenes.splice(i, 1);
  c.scenes.splice(Math.max(0, Math.min(toIndex, c.scenes.length)), 0, s);
  c.scenes.forEach((x, k) => { if (k === 0) x.transition.type = 'none'; else if (x === s && x.transition.type === 'none' && i === 0) x.transition = {type: 'fade', duration: 0.4, ease: 'easeInOutCubic'}; });
  return c;
}

export function setScene(comp, id, patch) {
  const c = clone(comp);
  const s = c.scenes.find(x => x.id === id);
  if (!s) return comp;
  Object.assign(s, typeof patch === 'function' ? patch(s) : patch);
  return normalizeComp(c);
}

// Resize a clip from its right edge. Shrinks via trimEnd, grows via duration.
export function resizeSceneEnd(comp, id, newLength) {
  return setScene(comp, id, s => {
    const want = Math.max(0.2, newLength) * s.speed;
    const visible = s.duration - s.trimStart - s.trimEnd;
    const delta = want - visible;
    if (delta <= 0) return {trimEnd: s.trimEnd - delta};
    const fromTrim = Math.min(delta, s.trimEnd);
    return {trimEnd: s.trimEnd - fromTrim, duration: s.duration + (delta - fromTrim)};
  });
}
export function resizeSceneStart(comp, id, newTrimStart) {
  return setScene(comp, id, s => ({trimStart: Math.max(0, Math.min(newTrimStart, s.duration - s.trimEnd - 0.2))}));
}

export function findLayer(comp, layerId) {
  for (const s of comp.scenes) { const l = s.layers.find(x => x.id === layerId); if (l) return {scene: s, layer: l}; }
  return null;
}
export function setLayer(comp, layerId, patch) {
  const c = clone(comp);
  for (const s of c.scenes) {
    const l = s.layers.find(x => x.id === layerId);
    if (l) { Object.assign(l, typeof patch === 'function' ? patch(l) : patch); return normalizeComp(c); }
  }
  return comp;
}
export function deleteLayer(comp, layerId) {
  const c = clone(comp);
  for (const s of c.scenes) s.layers = s.layers.filter(l => l.id !== layerId);
  return c;
}
export function moveLayer(comp, layerId, dir) {
  const c = clone(comp);
  for (const s of c.scenes) {
    const i = s.layers.findIndex(l => l.id === layerId);
    if (i < 0) continue;
    const j = Math.max(0, Math.min(s.layers.length - 1, i + dir));
    const [l] = s.layers.splice(i, 1); s.layers.splice(j, 0, l);
  }
  return c;
}
export function addLayer(comp, sceneId, layer) {
  const c = clone(comp);
  const s = c.scenes.find(x => x.id === sceneId);
  if (!s) return comp;
  s.layers.push({id: uid('l'), ...layer});
  return normalizeComp(c);
}

export function setAudio(comp, id, patch) {
  const c = clone(comp);
  const a = c.audio.find(x => x.id === id);
  if (!a) return comp;
  Object.assign(a, typeof patch === 'function' ? patch(a) : patch);
  return normalizeComp(c);
}
export function addAudio(comp, clip) {
  const c = clone(comp);
  if (clip.kind === 'music') c.audio = c.audio.filter(a => a.kind !== 'music');
  c.audio.push({id: uid('a'), volume: clip.kind === 'music' ? 0.75 : 0.65, ...clip});
  return normalizeComp(c);
}
export function deleteAudio(comp, id) { const c = clone(comp); c.audio = c.audio.filter(a => a.id !== id); return c; }

export function setFormat(comp, format) {
  const f = FORMATS[format];
  if (!f) return comp;
  const c = clone(comp);
  const kx = f.width / c.width, ky = f.height / c.height, k = Math.min(kx, ky);
  for (const s of c.scenes) for (const l of s.layers) {
    if (l.type === 'background') continue;
    l.x = l.x * kx; l.y = l.y * ky;
    if (l.width != null) l.width *= k;
    if (l.height != null) l.height *= k;
    if (l.type === 'text') l.size *= k;
    if (l.keyframes?.x) l.keyframes.x.forEach(f2 => { f2.v *= kx; });
    if (l.keyframes?.y) l.keyframes.y.forEach(f2 => { f2.v *= ky; });
  }
  c.width = f.width; c.height = f.height;
  return normalizeComp(c);
}

export const total = comp => timeline(comp).total;
export {timeline, playable};
