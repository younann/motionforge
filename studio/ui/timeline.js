import {html, useRef, useState, useEffect, useLayoutEffect} from '../vendor/preact-htm.js';
import {player} from './player.js';
import {usePlayhead} from './preview.js';
import {Btn, Icon, fmtTime} from './components.js';
import {timeline, splitScene, duplicateScene, deleteScene, moveScene, resizeSceneEnd, resizeSceneStart, setAudio, deleteAudio} from './ops.js';

const LABEL_W = 92;
const sceneColor = s => {
  const bg = s.layers.find(l => l.type === 'background');
  const stops = bg?.gradient?.stops?.map(x => x[0]) || [bg?.fill || s.background || '#333', bg?.fill || s.background || '#333'];
  return `linear-gradient(90deg, ${stops.slice(0, 3).join(', ')})`;
};
const sceneCaption = s => s.layers.find(l => l.type === 'text')?.text?.replace(/\s+/g, ' ').slice(0, 60) || '';

function drag(e, {onMove, onEnd}) {
  e.preventDefault(); e.stopPropagation();
  const x0 = e.clientX;
  let moved = false;
  const move = ev => { const dx = ev.clientX - x0; if (!moved && Math.abs(dx) < 3) return; moved = true; onMove(dx, ev); };
  const up = ev => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); onEnd?.(moved, ev.clientX - x0); };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
}

export function Timeline({p, sel, setSel, library}) {
  const c = p.comp;
  const {t} = usePlayhead();
  const scroller = useRef(null);
  const [width, setWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [ghost, setGhost] = useState(null);
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const tl = timeline(c);
  const total = tl.total;
  const span = Math.max(total, 5) * 1.08;
  const pps = Math.max(8, ((width - LABEL_W - 24) / span) * zoom);
  const contentW = Math.max(width - LABEL_W, span * pps + 40);
  const X = s => s * pps;

  useEffect(() => {
    const el = scroller.current; if (!el || !player.playing) return;
    const x = X(t) + LABEL_W;
    if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft + LABEL_W) el.scrollLeft = x - LABEL_W - 40;
  }, [t]);

  const seekFromEvent = e => {
    const rect = scroller.current.getBoundingClientRect();
    const x = e.clientX - rect.left + scroller.current.scrollLeft - LABEL_W;
    player.seek(Math.max(0, x / pps));
  };
  const scrubStart = e => {
    if (e.button !== 0) return;
    seekFromEvent(e);
    const move = ev => seekFromEvent(ev);
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };

  const selScene = sel?.kind === 'scene' || sel?.kind === 'layer' ? sel.sceneId : null;
  const ticks = [];
  const step = pps > 120 ? 0.5 : pps > 50 ? 1 : pps > 20 ? 2 : 5;
  for (let s = 0; s <= span; s += step) ticks.push(s);

  const sceneDown = (e, it) => {
    if (e.button !== 0) return;
    setSel({kind: 'scene', sceneId: it.scene.id});
    const down = {clientX: e.clientX};
    drag(e, {
      onMove: dx => setGhost({id: it.scene.id, dx}),
      onEnd: (moved, dx) => {
        setGhost(null);
        if (!moved) { seekFromEvent(down); return; }
        const center = it.start + it.length / 2 + dx / pps;
        let to = tl.items.filter(o => o.scene.id !== it.scene.id && o.start + o.length / 2 < center).length;
        if (to !== it.index) p.update(moveScene(c, it.scene.id, to));
      },
    });
  };
  const trimDown = (e, it, side) => {
    setSel({kind: 'scene', sceneId: it.scene.id});
    const base = p.comp, s0 = it.scene;
    drag(e, {
      onMove: dx => {
        if (side === 'end') p.update(resizeSceneEnd(base, s0.id, Math.max(0.3, it.length + dx / pps)), {commit: false, save: false});
        else p.update(resizeSceneStart(base, s0.id, s0.trimStart + (dx / pps) * s0.speed), {commit: false, save: false});
      },
      onEnd: moved => moved && p.commitNow(),
    });
  };

  const srcLen = a => {
    if (a.src.startsWith('lib:')) {
      const [, kind, id] = a.src.match(/^lib:(music|sfx)\/(.+)$/) || [];
      const item = library?.[kind]?.find(x => x.id === id);
      if (item) return item.duration;
    }
    return a.duration ?? Math.max(1, total - a.start + a.offset);
  };
  const audioLen = a => Math.max(0.05, Math.min(a.duration ?? srcLen(a) - a.offset, srcLen(a) - a.offset, Math.max(0.05, total - a.start)));
  const audioDown = (e, a, mode) => {
    if (e.button !== 0) return;
    setSel({kind: 'audio', id: a.id});
    const base = p.comp, len = audioLen(a);
    drag(e, {
      onMove: dx => {
        const d = dx / pps;
        let patch;
        if (mode === 'move') patch = {start: Math.max(0, a.start + d)};
        else if (mode === 'end') patch = {duration: Math.max(0.1, Math.min(srcLen(a) - a.offset, len + d))};
        else { const dd = Math.max(-a.offset, Math.min(len - 0.1, d)); patch = {start: Math.max(0, a.start + dd), offset: a.offset + dd, duration: len - dd}; }
        p.update(setAudio(base, a.id, patch), {commit: false, save: false});
      },
      onEnd: moved => moved && p.commitNow(),
    });
  };

  const tracks = [
    {kind: 'music', label: 'Music', icon: 'music'},
    {kind: 'sfx', label: 'Effects', icon: 'bolt'},
    {kind: 'voice', label: 'Voice', icon: 'volume'},
  ];
  const sceneSel = selScene && c.scenes.find(s => s.id === selScene);
  const audioSel = sel?.kind === 'audio' && c.audio.find(a => a.id === sel.id);

  return html`<div class="timeline">
    <div class="tl-toolbar">
      <${Btn} icon="undo" title="Undo (⌘Z)" onClick=${p.undo} disabled=${!p.canUndo}/>
      <${Btn} icon="redo" title="Redo (⇧⌘Z)" onClick=${p.redo} disabled=${!p.canRedo}/>
      <span class="tl-sep"></span>
      <${Btn} icon="split" label="Split" title="Split the scene at the playhead (S)" onClick=${() => p.update(splitScene(c, player.t))} disabled=${!c.scenes.length}/>
      <${Btn} icon="copy" title="Duplicate scene (⌘D)" onClick=${() => sceneSel && p.update(duplicateScene(c, sceneSel.id))} disabled=${!sceneSel}/>
      <${Btn} icon="trash" title="Delete selection (Delete)" onClick=${() => { if (audioSel) { p.update(deleteAudio(c, audioSel.id)); setSel(null); } else if (sceneSel) { p.update(deleteScene(c, sceneSel.id)); setSel(null); } }} disabled=${!sceneSel && !audioSel}/>
      <span class="grow"></span>
      <span class="tl-total mono">${fmtTime(total, c.fps)}${total > 30 ? html` <b class="warn">over 30s</b>` : ''}</span>
      <span class="tl-sep"></span>
      <${Btn} icon="zoomOut" title="Zoom out" onClick=${() => setZoom(z => Math.max(0.5, z / 1.4))}/>
      <input class="range tl-zoom" type="range" min="0.5" max="8" step="0.01" value=${zoom} onInput=${e => setZoom(Number(e.target.value))} aria-label="Timeline zoom" style=${`--p:${((zoom - 0.5) / 7.5) * 100}%`}/>
      <${Btn} icon="zoomIn" title="Zoom in" onClick=${() => setZoom(z => Math.min(8, z * 1.4))}/>
    </div>
    <div class="tl-scroll" ref=${scroller}>
      <div class="tl-content" style=${`width:${contentW + LABEL_W}px`}>
        <div class="tl-ruler" onPointerDown=${scrubStart}>
          <div class="tl-label tl-corner"></div>
          ${ticks.map(s => html`<span class="tick${s % (step * 2) === 0 ? ' major' : ''}" style=${`left:${LABEL_W + X(s)}px`}>${s % (step * 2) === 0 ? `${s}s` : ''}</span>`)}
        </div>
        <div class="tl-track tl-video">
          <div class="tl-label"><${Icon} name="layers" size=${14}/>Scenes</div>
          <div class="tl-lane" onPointerDown=${e => { if (e.target === e.currentTarget) { setSel(null); scrubStart(e); } }}>
            ${tl.items.map(it => {
              const s = it.scene, isSel = selScene === s.id;
              const dx = ghost?.id === s.id ? ghost.dx : 0;
              return html`<div class=${`clip clip-scene${isSel ? ' is-sel' : ''}${dx ? ' is-drag' : ''}`} style=${`left:${X(it.start) + dx}px;width:${Math.max(6, X(it.length))}px`}
                  onPointerDown=${e => sceneDown(e, it)} onDblClick=${() => player.seek(it.start + 0.01)} title=${`${s.name} · ${it.length.toFixed(2)}s`}>
                <div class="clip-band" style=${`background:${sceneColor(s)}`}></div>
                ${it.overlap > 0 && html`<div class="clip-trans" style=${`width:${X(it.overlap)}px`} title=${`${s.transition.type} transition`}></div>`}
                <div class="clip-text"><b>${s.name} <em class="mono">${it.length.toFixed(1)}s</em></b><span>${sceneCaption(s)}</span></div>
                <i class="handle handle-l" onPointerDown=${e => trimDown(e, it, 'start')} title="Trim start"></i>
                <i class="handle handle-r" onPointerDown=${e => trimDown(e, it, 'end')} title="Trim or extend end"></i>
              </div>`;
            })}
            ${!c.scenes.length && html`<div class="tl-empty">Scenes appear here once Claude makes your video.</div>`}
          </div>
        </div>
        ${tracks.map(tr => html`<div class=${`tl-track tl-audio tl-${tr.kind}`}>
          <div class="tl-label"><${Icon} name=${tr.icon} size=${14}/>${tr.label}</div>
          <div class="tl-lane" onPointerDown=${e => { if (e.target === e.currentTarget) { setSel(null); scrubStart(e); } }}>
            ${c.audio.filter(a => a.kind === tr.kind).map(a => {
              const len = audioLen(a), isSel = sel?.kind === 'audio' && sel.id === a.id;
              return html`<div class=${`clip clip-audio clip-${tr.kind}${isSel ? ' is-sel' : ''}${a.muted ? ' is-muted' : ''}`} style=${`left:${X(a.start)}px;width:${Math.max(4, X(len))}px`}
                  onPointerDown=${e => audioDown(e, a, 'move')} title=${a.name || a.src}>
                <${Wave} seed=${a.src} w=${Math.max(4, X(len))}/>
                <span class="clip-audio-name">${a.name || a.src.split('/').pop().replace(/^asset:/, '')}</span>
                <i class="handle handle-l" onPointerDown=${e => audioDown(e, a, 'start')}></i>
                <i class="handle handle-r" onPointerDown=${e => audioDown(e, a, 'end')}></i>
              </div>`;
            })}
          </div>
        </div>`)}
        <div class="playhead" style=${`left:${LABEL_W + X(t)}px`}><i onPointerDown=${scrubStart}></i></div>
      </div>
    </div>
  </div>`;
}

// Decorative waveform, stable per source.
function Wave({seed, w}) {
  let h = 0; for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const n = Math.max(2, Math.floor(w / 4));
  const bars = [];
  for (let i = 0; i < n; i++) { h = (h * 1664525 + 1013904223) >>> 0; bars.push(0.25 + ((h >>> 8) % 1000) / 1400); }
  return html`<svg class="wave" viewBox=${`0 0 ${n * 4} 20`} preserveAspectRatio="none" aria-hidden="true">${bars.map((b, i) => html`<rect x=${i * 4} y=${10 - b * 9} width="2.4" height=${b * 18} rx="1"/>`)}</svg>`;
}
