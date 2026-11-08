import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeComp, validateComp, timeline, emptyComp} from '../studio/engine/schema.js';
import {splitScene, resizeSceneEnd, moveScene, setFormat} from '../studio/ui/ops.js';
import {EASE, sampleKeyframes} from '../studio/engine/easing.js';

const comp = () => normalizeComp({
  width: 1080, height: 1920,
  scenes: [
    {id: 'a', duration: 3, layers: [{type: 'text', text: 'Hi', enter: 'chars-rise'}]},
    {id: 'b', duration: 2, transition: {type: 'fade', duration: 0.5}, layers: []},
  ],
  audio: [{kind: 'music', src: 'lib:music/energetic'}, {src: 'https://evil.example/x.mp3'}],
});

test('normalize fills defaults and drops bad audio', () => {
  const c = comp();
  assert.equal(c.scenes[0].layers[0].enter.preset, 'chars-rise');
  assert.equal(c.scenes[0].transition.type, 'none');
  assert.equal(c.audio.length, 1);
});

test('transitions overlap the previous scene', () => {
  const tl = timeline(comp());
  assert.equal(tl.items[1].start, 2.5);
  assert.equal(tl.total, 4.5);
});

test('validation reports unknown presets, bad image src and over-length', () => {
  const errs = validateComp({scenes: [{duration: 20, layers: [{type: 'image', src: '/etc/passwd'}, {type: 'text', enter: 'explode'}]}, {duration: 20, layers: []}]});
  assert.ok(errs.some(e => /needs src/.test(e)));
  assert.ok(errs.some(e => /unknown/.test(e)));
  assert.ok(errs.some(e => /exceeds 30s/.test(e)));
  assert.deepEqual(validateComp({scenes: [{duration: 2, layers: [{type: 'background'}]}]}), []);
});

test('split keeps the total length and gives fresh ids', () => {
  const c = comp();
  const s = splitScene(c, 1.2);
  assert.equal(s.scenes.length, 3);
  assert.ok(Math.abs(timeline(s).total - timeline(c).total) < 1e-9);
  assert.notEqual(s.scenes[1].layers[0]?.id, s.scenes[0].layers[0].id);
});

test('resize end extends duration beyond trims', () => {
  const c = resizeSceneEnd(comp(), 'a', 4);
  assert.equal(c.scenes[0].duration, 4);
});

test('moving a scene to the front clears its transition', () => {
  const c = moveScene(comp(), 'b', 0);
  assert.equal(c.scenes[0].id, 'b');
  assert.equal(c.scenes[0].transition.type, 'none');
});

test('format change rescales layers', () => {
  const c = setFormat(comp(), '1:1');
  assert.equal(c.height, 1080);
  assert.ok(c.scenes[0].layers[0].size < 96);
});

test('easings start at 0 and end at 1', () => {
  for (const [name, f] of Object.entries(EASE)) {
    assert.ok(Math.abs(f(0)) < 1e-6, `${name}(0)`);
    assert.ok(Math.abs(f(1) - 1) < 1e-6, `${name}(1)`);
  }
  assert.equal(sampleKeyframes([{t: 0, v: 0}, {t: 1, v: 10, ease: 'linear'}], 0.5), 5);
});

test('empty comp is valid input for the director', () => {
  const c = emptyComp('16:9');
  assert.equal(c.width, 1920);
  assert.equal(c.scenes.length, 0);
});

test('ui markup is sanitized', async () => {
  const {sanitizeHtml} = await import('../studio/engine/schema.js');
  const out = sanitizeHtml('<div onclick="x()"><script>alert(1)</script><img onerror=alert(1) src="https://evil.example/a.png"><img src="asset:p.png"><iframe src="x"></iframe></div>');
  assert.ok(!/script|onclick|onerror|iframe|evil/.test(out), out);
  assert.match(out, /asset:p\.png/);
});

test('new layer types and camera normalize', () => {
  const c = normalizeComp({scenes: [{duration: 2, camera: {zoom: [[0, 1.2], [2, 1]]}, layers: [
    {type: 'ui', device: 'iphone', html: '<b>hi</b>', css: '@import url(x); .a{background:url(https://x/y.png)}'},
    {type: 'effect', effect: 'confetti', density: 9},
    {type: 'cursor', taps: [1.5, 0.5]},
    {type: 'image', prompt: 'a shoe'},
  ]}]});
  const [ui, fx, cur, img] = c.scenes[0].layers;
  assert.equal(c.scenes[0].camera.zoom.length, 2);
  assert.ok(!/@import|https/.test(ui.css));
  assert.equal(ui.viewport.width, 390);
  assert.equal(fx.density, 4);
  assert.deepEqual(cur.taps, [0.5, 1.5]);
  assert.equal(img.prompt, 'a shoe');
  assert.deepEqual(validateComp({scenes: [{duration: 2, layers: [{type: 'effect', effect: 'lava'}]}]}).length, 1);
});
