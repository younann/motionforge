// Image generation providers. Fills image layers that carry a prompt.
import {createHash} from 'node:crypto';
import {writeFile, stat, mkdir} from 'node:fs/promises';
import {join} from 'node:path';

const UA = 'MotionForge/0.3';
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(Error('cancelled')); }, {once: true});
});

function sizeFor(layer, comp) {
  const w = layer.width || comp.width * 0.7, h = layer.height || w;
  const long = 1280;
  const k = long / Math.max(w, h);
  const r16 = v => Math.max(256, Math.round((v * k) / 16) * 16);
  return {width: r16(w), height: r16(h)};
}

async function fetchImage(url, init, signal, timeout = 150000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop, {once: true});
  try {
    const res = await fetch(url, {...init, signal: ctrl.signal, headers: {'user-agent': UA, ...(init?.headers || {})}});
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('image/')) {
      const text = type.includes('json') || type.startsWith('text') ? (await res.text()).slice(0, 400) : '';
      let msg = text;
      try { const j = JSON.parse(text); msg = j.error?.message || j.error || j.message || text; } catch {}
      const err = Error(`HTTP ${res.status}${msg ? `: ${String(msg).slice(0, 200)}` : ''}`);
      // Rate limited: tell the caller how long to wait.
      if (res.status === 429 || res.status === 402 || /limit/i.test(msg)) {
        const ra = Number(res.headers.get('retry-after')) || Number(String(msg).match(/(\d+)\s*s(?:ec|econds)?\b/i)?.[1]) || 45;
        err.retryAfter = Math.min(120, ra + 1);
      }
      throw err;
    }
    return {data: Buffer.from(await res.arrayBuffer()), type};
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

export const PROVIDERS = {
  pollinations: {
    label: 'Pollinations (free)',
    async generate({prompt, width, height, seed, settings, signal}) {
      const q = new URLSearchParams({width, height, seed: String(seed), model: 'flux', nologo: 'true', enhance: 'false', private: 'true'});
      const headers = settings.pollinationsToken ? {authorization: `Bearer ${settings.pollinationsToken}`} : {};
      return fetchImage(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${q}`, {headers}, signal);
    },
  },
  huggingface: {
    label: 'Hugging Face (FLUX.1 schnell)',
    async generate({prompt, width, height, seed, settings, signal}) {
      if (!settings.hfToken) throw Error('Add a Hugging Face token in Settings');
      return fetchImage('https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell', {
        method: 'POST',
        headers: {authorization: `Bearer ${settings.hfToken}`, 'content-type': 'application/json', accept: 'image/png'},
        body: JSON.stringify({inputs: prompt, parameters: {width, height, num_inference_steps: 4, seed}}),
      }, signal);
    },
  },
};

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'image';

// Generates every missing image. Mutates comp layers to point at the saved asset.
export async function resolveImages({comp, projectDir, settings, signal, onEvent}) {
  const provider = PROVIDERS[settings.imageProvider];
  const jobs = [];
  for (const s of comp.scenes) for (const l of s.layers) {
    if (l.type !== 'image' || !l.prompt) continue;
    // Keep user images and images already made for this prompt.
    if (l.src?.startsWith('asset:') && (!l.genPrompt || l.genPrompt === l.prompt)) continue;
    jobs.push(l);
  }
  if (!jobs.length) return {generated: 0, failed: []};
  if (!provider) return {generated: 0, failed: jobs.map(l => ({layer: l.id, error: 'Image generation is turned off in Settings'}))};
  const adir = join(projectDir, 'assets');
  await mkdir(adir, {recursive: true, mode: 0o700});
  const failed = [];
  let done = 0, generated = 0;
  onEvent?.({type: 'step', label: `Generating ${jobs.length} image${jobs.length > 1 ? 's' : ''}`});
  const queue = [...jobs];
  async function worker() {
    while (queue.length) {
      const l = queue.shift();
      const {width, height} = sizeFor(l, comp);
      const seed = l.seed ?? (parseInt(createHash('sha1').update(l.prompt).digest('hex').slice(0, 6), 16) % 100000);
      const key = createHash('sha1').update(`${settings.imageProvider}|${l.prompt}|${width}x${height}|${seed}`).digest('hex').slice(0, 10);
      const name = `gen-${slug(l.prompt)}-${key}.jpg`;
      const file = join(adir, name);
      try {
        const exists = await stat(file).then(() => true, () => false);
        if (!exists) {
          let img, err;
          for (let attempt = 0; attempt < 8 && !img; attempt++) {
            try { img = await provider.generate({prompt: l.prompt, width, height, seed, settings, signal}); }
            catch (e) {
              err = e;
              if (signal?.aborted) throw e;
              if (e.retryAfter) {
                onEvent?.({type: 'step', label: `Waiting ${e.retryAfter}s for the free image limit (image ${done + 1} of ${jobs.length})`});
                await sleep(e.retryAfter * 1000, signal);
              } else if (attempt >= 1) break;
            }
          }
          if (!img) throw err;
          await writeFile(file, img.data, {mode: 0o600});
          generated++;
        }
        l.src = `asset:${name}`;
        l.genPrompt = l.prompt;
      } catch (e) {
        failed.push({layer: l.id, prompt: l.prompt, error: String(e.message).slice(0, 200)});
      }
      done++;
      onEvent?.({type: 'step', label: `Generated image ${done} of ${jobs.length}`});
    }
  }
  // Free anonymous tier allows one image at a time.
  const lanes = settings.imageProvider === 'pollinations' && !settings.pollinationsToken ? 1 : 3;
  await Promise.all(Array.from({length: lanes}, worker));
  return {generated, failed};
}
