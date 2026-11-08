import {html, render, useState, useEffect} from './vendor/preact-htm.js';
import {api, patch, token} from './ui/api.js';
import {player} from './ui/player.js';
import {useProject} from './ui/project.js';
import {Btn, Icon, Seg} from './ui/components.js';
import {Home, Simple, Editor, ExportDialog, SettingsDialog} from './ui/views.js';

const store = {
  get: k => { try { return localStorage.getItem(`mf.${k}`); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(`mf.${k}`) : localStorage.setItem(`mf.${k}`, v); } catch {} },
};

function useToasts() {
  const [list, setList] = useState([]);
  const toast = (text, kind = 'info') => {
    const id = Math.random();
    setList(l => [...l.slice(-3), {id, text, kind}]);
    setTimeout(() => setList(l => l.filter(t => t.id !== id)), kind === 'error' ? 7000 : 3500);
  };
  const view = html`<div class="toasts" aria-live="polite">${list.map(t => html`<div class=${`toast toast-${t.kind}`}>${t.text}</div>`)}</div>`;
  return [toast, view];
}

function TopBar({p, mode, setMode, onHome, openExport, openSettings}) {
  const [title, setTitle] = useState(p.project?.title || '');
  useEffect(() => setTitle(p.project?.title || ''), [p.project?.title]);
  const save = async () => {
    const t = title.trim() || 'Untitled video';
    if (t !== p.project.title) { await patch(`/projects/${p.project.id}`, {title: t}); p.update({...p.comp, title: t}); p.reload(); }
  };
  return html`<header class="topbar">
    <button class="brand brand-btn" onClick=${onHome} title="All videos"><span class="brand-mark"></span><span class="brand-word">MotionForge</span></button>
    <span class="topbar-sep"></span>
    <input class="title-input" value=${title} onInput=${e => setTitle(e.target.value)} onBlur=${save} onKeyDown=${e => e.key === 'Enter' && e.target.blur()} aria-label="Video title"/>
    <div class="topbar-center">
      <${Seg} value=${mode} onChange=${setMode} options=${[{value: 'simple', label: 'Simple'}, {value: 'editor', label: 'Editor'}, {value: 'pro', label: 'Pro', disabled: true, title: 'Layer and keyframe editing is coming next'}]}/>
    </div>
    <div class="topbar-right">
      ${p.gen && html`<span class="live-dot" title="Claude is working">Directing</span>`}
      <${Btn} icon="sliders" title="Settings" onClick=${openSettings}/>
      <${Btn} kind="primary" icon="download" label="Export" onClick=${openExport} disabled=${!p.comp?.scenes.length || !!p.gen}/>
    </div>
  </header>`;
}

function Workspace({id, mode, setMode, onHome, toast, library, system}) {
  const p = useProject(id, toast);
  const [exporting, setExporting] = useState(false);
  const [settings, setSettings] = useState(false);
  useEffect(() => { if (p.exp?.running) setExporting(true); }, [p.exp?.running]);
  if (p.error) return html`<main class="center-msg"><p>${p.error}</p><${Btn} kind="secondary" label="Back to all videos" onClick=${onHome}/></main>`;
  if (p.loading || !p.comp) return html`<main class="center-msg"><p class="muted">Opening…</p></main>`;
  const openExport = () => {
    if (system && (!system.chrome || !system.ffmpeg)) { toast(!system.ffmpeg ? 'Export needs ffmpeg. Install it (macOS: brew install ffmpeg), then reopen MotionForge.' : 'Export needs Google Chrome or another Chromium browser.', 'error'); return; }
    setExporting(true);
  };
  return html`<div class="workspace">
    <${TopBar} p=${p} mode=${mode} setMode=${setMode} onHome=${onHome} openExport=${openExport} openSettings=${() => setSettings(true)}/>
    ${mode === 'editor' ? html`<${Editor} p=${p} library=${library} openExport=${openExport} toast=${toast}/>` : html`<${Simple} p=${p} setMode=${setMode} openExport=${openExport}/>`}
    ${exporting && html`<${ExportDialog} p=${p} onClose=${() => setExporting(false)}/>`}
    ${settings && html`<${SettingsDialog} onClose=${() => setSettings(false)} toast=${toast}/>`}
  </div>`;
}

function App() {
  const [toast, toasts] = useToasts();
  const [route, setRoute] = useState({id: store.get('project'), mode: store.get('mode') || 'simple'});
  const [library, setLibrary] = useState(null);
  const [system, setSystem] = useState(null);
  const [fatal, setFatal] = useState(token ? null : 'This page needs a fresh link. Run /motionforge:open in Claude Code to get one.');
  useEffect(() => {
    if (!token) return;
    api('/health').catch(e => setFatal(e.message));
    api('/library').then(l => { setLibrary(l); player.library = l; }).catch(() => {});
    api('/system').then(s => {
      setSystem(s);
      if (!s.claude) toast('Claude Code CLI was not found on this machine, so generation will fail.', 'error');
    }).catch(() => {});
  }, []);
  const go = (id, mode = route.mode) => {
    player.pause();
    store.set('project', id); store.set('mode', mode);
    setRoute({id, mode});
  };
  if (fatal) return html`<main class="center-msg"><div class="brand"><span class="brand-mark"></span>MotionForge</div><p>${fatal}</p></main>`;
  return html`<div class="app">
    ${route.id
      ? html`<${Workspace} key=${route.id} id=${route.id} mode=${route.mode} setMode=${m => go(route.id, m)} onHome=${() => go(null)} toast=${toast} library=${library} system=${system}/>`
      : html`<${Home} onOpen=${go} toast=${toast}/>`}
    ${toasts}
  </div>`;
}

render(html`<${App}/>`, document.getElementById('root'));
