// Project state: comp with undo/redo, autosave, generation and export jobs.
import {useState, useEffect, useRef, useCallback} from '../vendor/preact-htm.js';
import {api, post, put, upload, follow} from './api.js';
import {player} from './player.js';

export function useProject(id, toast) {
  const [state, setState] = useState({loading: true});
  const [comp, setCompState] = useState(null);
  const [gen, setGen] = useState(null);
  const [exp, setExp] = useState(null);
  const hist = useRef({stack: [], index: -1});
  const saveTimer = useRef(null);
  const compRef = useRef(null);
  const [, force] = useState(0);

  const persist = useCallback(c => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => put(`/projects/${id}/comp`, {comp: c}).catch(e => toast(`Couldn't save: ${e.message}`, 'error')), 450);
  }, [id]);

  const apply = (c, {commit = true, save = true} = {}) => {
    compRef.current = c;
    setCompState(c);
    player.load(c, id);
    if (commit) {
      const h = hist.current;
      h.stack = h.stack.slice(0, h.index + 1);
      h.stack.push(JSON.stringify(c));
      if (h.stack.length > 120) h.stack.shift();
      h.index = h.stack.length - 1;
      force(x => x + 1);
    }
    if (save) persist(c);
  };

  const reload = useCallback(async () => {
    const data = await api(`/projects/${id}`);
    setState({loading: false, project: data.project, assets: data.assets, exports: data.exports});
    return data;
  }, [id]);

  useEffect(() => {
    let alive = true;
    hist.current = {stack: [], index: -1};
    setCompState(null); setGen(null); setExp(null);
    setState({loading: true});
    reload().then(data => { if (alive) apply(data.comp, {save: false}); }).catch(e => { if (alive) setState({loading: false, error: e.message}); });
    return () => { alive = false; clearTimeout(saveTimer.current); };
  }, [id]);

  const update = (fn, opts) => { const cur = compRef.current; if (!cur) return; const next = typeof fn === 'function' ? fn(cur) : fn; if (next && next !== cur) apply(next, opts); };
  const commitNow = () => { const h = hist.current; const s = JSON.stringify(compRef.current); if (h.stack[h.index] !== s) apply(compRef.current); };
  const undo = () => { const h = hist.current; if (h.index <= 0) return; h.index--; apply(JSON.parse(h.stack[h.index]), {commit: false}); force(x => x + 1); };
  const redo = () => { const h = hist.current; if (h.index >= h.stack.length - 1) return; h.index++; apply(JSON.parse(h.stack[h.index]), {commit: false}); force(x => x + 1); };

  async function generate(input) {
    if (gen?.running) return;
    clearTimeout(saveTimer.current);
    if (compRef.current) await put(`/projects/${id}/comp`, {comp: compRef.current}).catch(() => {});
    const steps = [];
    const started = Date.now();
    setGen({running: true, steps, prompt: input.prompt, started, text: ''});
    setState(s => ({...s, project: {...s.project, messages: [...s.project.messages, {role: 'user', text: input.prompt, attachments: input.attachments || [], sceneId: input.sceneId || null, at: new Date().toISOString()}]}}));
    try {
      const {jobId} = await post(`/projects/${id}/generate`, input);
      setGen(g => ({...g, jobId}));
      const final = await follow(jobId, e => {
        if (e.type === 'step') setGen(g => (g && g.steps.at(-1)?.label === e.label ? g : {...g, steps: [...g.steps, {label: e.label, at: e.at}]}));
        if (e.type === 'text') setGen(g => ({...g, text: e.text}));
      });
      if (final.type === 'done') {
        apply(final.comp, {save: false});
        player.seek(0);
        toast('Your video is ready', 'ok');
      } else if (final.status !== 'cancelled') toast(final.message || 'Generation failed', 'error');
    } catch (e) { toast(e.message, 'error'); }
    finally { setGen(null); await reload().catch(() => {}); }
  }
  const cancelGenerate = () => gen?.jobId && post(`/jobs/${gen.jobId}/cancel`);

  async function startExport(opts) {
    clearTimeout(saveTimer.current);
    await put(`/projects/${id}/comp`, {comp: compRef.current});
    setExp({running: true, pct: 0, phase: 'starting', opts});
    try {
      const {jobId} = await post(`/projects/${id}/export`, opts);
      setExp(x => ({...x, jobId}));
      const final = await follow(jobId, e => { if (e.type === 'progress') setExp(x => ({...x, ...e})); });
      if (final.type === 'done') { setExp({done: true, file: final.file}); await reload(); }
      else setExp({error: final.status === 'cancelled' ? null : final.message, cancelled: final.status === 'cancelled'});
    } catch (e) { setExp({error: e.message}); }
  }
  const cancelExport = () => exp?.jobId && post(`/jobs/${exp.jobId}/cancel`);

  async function addFiles(files) {
    const names = [];
    for (const f of files) {
      try { const r = await upload(id, f); names.push(r.name); setState(s => ({...s, assets: r.assets})); }
      catch (e) { toast(`${f.name}: ${e.message}`, 'error'); }
    }
    return names;
  }

  async function generateImages() {
    clearTimeout(saveTimer.current);
    await put(`/projects/${id}/comp`, {comp: compRef.current});
    toast('Generating images…');
    try {
      const r = await post(`/projects/${id}/images`);
      apply(r.comp, {save: false});
      setState(s => ({...s, assets: r.assets}));
      if (r.failed.length) toast(`Couldn't generate: ${r.failed[0].error}`, 'error'); else toast(r.generated ? 'Image ready' : 'Nothing to generate', 'ok');
    } catch (e) { toast(e.message, 'error'); }
  }

  const h = hist.current;
  return {
    ...state, comp, update, commitNow, undo, redo, canUndo: h.index > 0, canRedo: h.index < h.stack.length - 1,
    gen, generate, cancelGenerate, generateImages, exp, setExp, startExport, cancelExport, addFiles, reload,
  };
}
