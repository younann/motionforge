// Renders a contact sheet of key frames so the director can review its work.
import {mkdir, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {launchChrome} from './chrome.mjs';
import {findBinary, run} from './media.mjs';
import {timeline} from '../studio/engine/schema.js';

export function reviewTimes(comp) {
  const times = [];
  for (const it of timeline(comp).items) {
    const a = it.start + Math.min(1.1, it.length * 0.45);
    const b = it.end - Math.min(0.25, it.length * 0.1);
    times.push({t: a, scene: it.scene.name}, {t: b, scene: it.scene.name});
  }
  return times.slice(0, 16);
}

export async function renderContactSheet({comp, projectId, projectDir, origin, token, signal}) {
  const ffmpeg = findBinary('ffmpeg');
  if (!ffmpeg) throw Error('ffmpeg not found');
  const times = reviewTimes(comp);
  const dir = join(projectDir, 'review');
  await rm(dir, {recursive: true, force: true});
  await mkdir(dir, {recursive: true, mode: 0o700});
  const scale = 432 / Math.min(comp.width, comp.height);
  const browser = await launchChrome({width: comp.width, height: comp.height, scale});
  try {
    await browser.page('Page.navigate', {url: `${origin}/export.html#token=${encodeURIComponent(token)}&project=${projectId}`});
    for (let i = 0; i < 200; i++) {
      const st = await browser.evaluate('window.__mfState || "loading"', false).catch(() => 'loading');
      if (st === 'ready') break;
      if (typeof st === 'string' && st.startsWith('error:')) throw Error(st.slice(6));
      if (i === 199) throw Error('Review page did not load');
      await new Promise(r => setTimeout(r, 150));
    }
    for (let i = 0; i < times.length; i++) {
      if (signal?.aborted) throw Error('cancelled');
      await browser.evaluate(`window.__mfSeek(${times[i].t})`);
      const {data} = await browser.page('Page.captureScreenshot', {format: 'jpeg', quality: 88, fromSurface: true});
      await writeFile(join(dir, `f${String(i).padStart(2, '0')}.jpg`), Buffer.from(data, 'base64'));
    }
  } finally { await browser.close(); }
  const cols = Math.min(4, times.length), rows = Math.ceil(times.length / cols);
  const sheet = join(dir, 'contact-sheet.jpg');
  await run(ffmpeg, ['-v', 'error', '-y', '-framerate', '1', '-i', join(dir, 'f%02d.jpg'), '-vf', `tile=${cols}x${rows}:padding=12:margin=12:color=0x202024`, '-frames:v', '1', '-q:v', '3', sheet], {timeout: 30000});
  return {sheet: 'review/contact-sheet.jpg', times, cols};
}
