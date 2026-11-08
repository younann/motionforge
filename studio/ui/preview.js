import {html, useEffect, useRef, useState} from '../vendor/preact-htm.js';
import {player} from './player.js';
import {Btn, Icon, fmtTime} from './components.js';

export function usePlayhead() {
  const [s, set] = useState({t: player.t, playing: player.playing});
  useEffect(() => player.subscribe((t, playing) => set({t, playing})), []);
  return s;
}

export function Stage({editable = true}) {
  const ref = useRef(null);
  useEffect(() => {
    player.editable = editable;
    player.attach(ref.current);
  }, [editable]);
  return html`<iframe ref=${ref} class="stage-frame" sandbox="allow-scripts" src="/stage.html" title="Video preview"></iframe>`;
}

export function Transport({comp, compact}) {
  const {t, playing} = usePlayhead();
  const [loop, setLoop] = useState(player.loop);
  const total = player.duration;
  return html`<div class=${`transport${compact ? ' compact' : ''}`}>
    <div class="transport-buttons">
      <${Btn} icon="back" title="Go to start (Home)" onClick=${() => player.seek(0)}/>
      <button class="play" onClick=${() => player.toggle()} aria-label=${playing ? 'Pause' : 'Play'} title=${playing ? 'Pause (Space)' : 'Play (Space)'} disabled=${!comp?.scenes.length}>
        <${Icon} name=${playing ? 'pause' : 'play'} size=${18}/>
      </button>
      <${Btn} icon="loop" title="Loop playback" active=${loop} onClick=${() => { player.loop = !player.loop; setLoop(player.loop); }}/>
    </div>
    <div class="timecode"><b>${fmtTime(t, comp?.fps)}</b><span>/ ${fmtTime(total, comp?.fps)}</span></div>
    ${compact && html`<input class="range scrub" type="range" min="0" max=${total || 1} step="0.001" value=${t} onInput=${e => player.seek(Number(e.target.value))} aria-label="Scrub" style=${`--p:${total ? (t / total) * 100 : 0}%`}/>`}
  </div>`;
}

export function Slate({gen, onCancel}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(i); }, []);
  const secs = Math.floor((now - gen.started) / 1000);
  const steps = gen.steps.length ? gen.steps : [{label: 'Starting Claude'}];
  return html`<div class="slate" role="status" aria-live="polite">
    <div class="slate-board">
      <div class="slate-clapper"><i></i><i></i><i></i><i></i><i></i><i></i></div>
      <div class="slate-body">
        <div class="slate-row"><span>Take</span><b>${gen.prompt.length > 70 ? gen.prompt.slice(0, 70) + '…' : gen.prompt}</b></div>
        <ol class="slate-steps">
          ${steps.slice(-5).map((s, i, a) => html`<li class=${i === a.length - 1 ? 'live' : 'done'}>${s.label}</li>`)}
        </ol>
        <div class="slate-foot"><span class="mono">${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}</span>
          <button class="link" onClick=${onCancel}>Cancel</button></div>
      </div>
    </div>
    <p class="slate-note">Claude is directing your video. A full ad usually takes one to three minutes.</p>
  </div>`;
}
