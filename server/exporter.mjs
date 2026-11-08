import {spawn} from 'node:child_process';
import {mkdir, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {launchChrome} from './chrome.mjs';
import {findBinary, mediaDuration} from './media.mjs';
import {timeline} from '../studio/engine/schema.js';

const slug = s => String(s || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video';

export async function exportVideo({comp, projectId, projectDir, origin, token, resolveAudio, quality = '1080', fps, signal, onProgress}) {
  const ffmpeg = findBinary('ffmpeg');
  if (!ffmpeg) throw Error('ffmpeg not found. Install it (macOS: brew install ffmpeg) or set MOTIONFORGE_FFMPEG.');
  const total = timeline(comp).total;
  if (!comp.scenes.length || total <= 0) throw Error('Nothing to export yet.');
  fps = [24, 25, 30, 50, 60].includes(Number(fps)) ? Number(fps) : comp.fps;
  const short = Math.min(comp.width, comp.height);
  const target = quality === '4k' ? 2160 : quality === '720' ? 720 : 1080;
  const scale = target / short;
  const outW = Math.round((comp.width * scale) / 2) * 2, outH = Math.round((comp.height * scale) / 2) * 2;
  const frames = Math.max(1, Math.round(total * fps));

  // Audio graph
  const inputs = [], filters = [], labels = [];
  for (const clip of comp.audio) {
    if (clip.muted) continue;
    const file = await resolveAudio(clip.src);
    if (!file) continue;
    const srcDur = (await mediaDuration(file)) ?? 600;
    const dur = Math.min(clip.duration ?? srcDur - clip.offset, srcDur - clip.offset, total - clip.start);
    if (!(dur > 0.02)) continue;
    const k = inputs.length + 1;
    inputs.push(file);
    const ms = Math.round(clip.start * 1000);
    let f = `[${k}:a]atrim=start=${clip.offset.toFixed(3)}:duration=${dur.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${clip.volume.toFixed(3)}`;
    if (clip.fadeIn > 0) f += `,afade=t=in:st=0:d=${Math.min(clip.fadeIn, dur).toFixed(3)}`;
    if (clip.fadeOut > 0) f += `,afade=t=out:st=${Math.max(0, dur - clip.fadeOut).toFixed(3)}:d=${Math.min(clip.fadeOut, dur).toFixed(3)}`;
    f += `,adelay=${ms}|${ms}[a${k}]`;
    filters.push(f);
    labels.push(`[a${k}]`);
  }
  if (labels.length) filters.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,alimiter=limit=0.93:level=false,apad,atrim=0:${total.toFixed(3)}[aout]`);

  const outDir = join(projectDir, 'exports');
  await mkdir(outDir, {recursive: true, mode: 0o700});
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const name = `${slug(comp.title)}-${quality}-${fps}fps-${stamp}.mp4`;
  const tmp = join(outDir, `.${name}.part.mp4`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', 'pipe:0'];
  for (const f of inputs) args.push('-i', f);
  if (filters.length) args.push('-filter_complex', filters.join(';'), '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000');
  else args.push('-map', '0:v');
  args.push(
    '-vf', `scale=${outW}:${outH}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', quality === '4k' ? '17' : '15', '-profile:v', 'high', '-tune', 'animation',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-r', String(fps), '-t', total.toFixed(3), '-movflags', '+faststart', tmp,
  );

  const browser = await launchChrome({width: comp.width, height: comp.height, scale});
  const enc = spawn(ffmpeg, args, {stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true});
  let encErr = '';
  enc.stderr.on('data', d => { encErr = (encErr + d).slice(-6000); });
  const encDone = new Promise((res, rej) => { enc.on('close', c => (c === 0 ? res() : rej(Error(`ffmpeg failed: ${encErr.trim().slice(-800)}`)))); enc.on('error', rej); });
  enc.stdin.on('error', () => {});
  const abort = () => { enc.kill('SIGKILL'); browser.close(); };
  signal?.addEventListener('abort', abort, {once: true});
  const started = Date.now();
  try {
    await browser.page('Page.navigate', {url: `${origin}/export.html#token=${encodeURIComponent(token)}&project=${projectId}`});
    for (let i = 0; i < 200; i++) {
      const state = await browser.evaluate('window.__mfState || "loading"', false).catch(() => 'loading');
      if (state === 'ready') break;
      if (typeof state === 'string' && state.startsWith('error:')) throw Error(state.slice(6));
      if (i === 199) throw Error(`Export page did not load. ${browser.consoleLines.slice(-3).join(' ')}`);
      await new Promise(r => setTimeout(r, 150));
    }
    onProgress?.({phase: 'render', frame: 0, frames, pct: 0});
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw Error('Export cancelled');
      const t = i / fps;
      await browser.evaluate(`window.__mfSeek(${t})`);
      const {data} = await browser.page('Page.captureScreenshot', {format: 'png', fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: true});
      const buf = Buffer.from(data, 'base64');
      if (!enc.stdin.write(buf)) await new Promise(r => enc.stdin.once('drain', r));
      if (i % 3 === 0 || i === frames - 1) {
        const elapsed = (Date.now() - started) / 1000;
        onProgress?.({phase: 'render', frame: i + 1, frames, pct: (i + 1) / frames, eta: Math.round((elapsed / (i + 1)) * (frames - i - 1))});
      }
    }
    enc.stdin.end();
    onProgress?.({phase: 'encode', frame: frames, frames, pct: 1});
    await encDone;
    await rename(tmp, join(outDir, name));
    return {name, width: outW, height: outH, fps, duration: total, seconds: Math.round((Date.now() - started) / 1000)};
  } catch (e) {
    enc.kill('SIGKILL');
    await rm(tmp, {force: true}).catch(() => {});
    throw signal?.aborted ? Error('Export cancelled') : e;
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser.close();
  }
}
