import {readFile, readdir, mkdir, copyFile} from 'node:fs/promises';
import {resolveImages} from './images.mjs';
import {renderContactSheet} from './review.mjs';
import {join, extname} from 'node:path';
import {runClaude} from './claude.mjs';
import {imageSize, mediaDuration} from './media.mjs';
import {IMAGE_EXT, AUDIO_EXT} from './store.mjs';
import {validateComp, normalizeComp, timeline, FORMATS} from '../studio/engine/schema.js';

const STYLE_HINTS = {
  bold: 'Bold & punchy: heavy condensed display type, high contrast, fast cuts, snappy expo easing.',
  minimal: 'Minimal & clean: lots of negative space, one accent color, refined sans, calm elegant easing.',
  luxury: 'Luxury: dark rich backgrounds, serif display type, gold/cream accents, slow graceful motion, shimmer.',
  playful: 'Playful: bright saturated palette, rounded shapes, bouncy back/spring easing, pops and confetti.',
  tech: 'Tech / product launch: dark UI aesthetic, neon glow accents, grids and light rays, precise motion.',
  cinematic: 'Cinematic: dramatic lighting, big type reveals, slow push-ins, impacts on reveals, film grain.',
};

export async function buildSystemPrompt(root, library, settings = {}) {
  let base = await readFile(join(root, 'server', 'prompts', 'director.md'), 'utf8');
  if (!settings.imageProvider || settings.imageProvider === 'none') base += '\n\nNOTE: image generation is turned OFF for this user. Do not use image prompts; use only images in assets/, UI layers, shapes and effects.\n';
  if (!library) return base;
  const music = library.music.map(m => `- \`lib:music/${m.id}\`: ${m.title}, ${m.bpm} BPM, ${m.duration.toFixed(1)} s. ${m.description || ''} (moods: ${(m.mood || []).join(', ')})`).join('\n');
  const sfx = library.sfx.map(s => `- \`lib:sfx/${s.id}\`: ${s.duration.toFixed(2)} s. ${s.description || ''}`).join('\n');
  return `${base}\n\n## Audio library\n\nMusic:\n${music}\n\nSound effects:\n${sfx}\n`;
}

export async function buildUserPrompt({prompt, comp, scene, attachments = [], imageMode = 'auto', duration, style, projectDir}) {
  const lines = ['## Request', prompt.trim(), '', '## Settings'];
  const fmt = Object.entries(FORMATS).find(([, v]) => v.width === comp.width && v.height === comp.height)?.[0] || 'custom';
  lines.push(`- Format: ${fmt} (${comp.width}×${comp.height}), ${comp.fps} fps.`);
  const current = timeline(comp).total;
  if (duration) lines.push(`- Target length: ${duration} s.`);
  else if (comp.scenes.length) lines.push(`- Current length: ${current.toFixed(1)} s (keep it unless asked).`);
  else lines.push('- Target length: 15 s.');
  if (style && STYLE_HINTS[style]) lines.push(`- Style: ${STYLE_HINTS[style]}`);
  if (scene) lines.push(`- Scope: change ONLY the scene with id "${scene.id}" ("${scene.name}"). Leave every other scene and the audio exactly as they are, except shifting SFX if the scene length changes.`);
  else if (comp.scenes.length) lines.push('- Scope: the whole video. The existing comp.json is the current state; build on it unless the request asks for something new.');
  else lines.push('- Scope: comp.json is empty. Create the full video.');
  const imgs = [], auds = [];
  for (const name of attachments) {
    const ext = extname(name).toLowerCase();
    const file = join(projectDir, 'assets', name);
    if (IMAGE_EXT.includes(ext)) {
      const size = await imageSize(file).catch(() => null);
      imgs.push(`- assets/${name}${size ? ` (${size.width}×${size.height} px)` : ''}: reference it as "asset:${name}"`);
    } else if (AUDIO_EXT.includes(ext)) {
      const d = await mediaDuration(file);
      auds.push(`- assets/${name}${d ? ` (${d.toFixed(1)} s)` : ''}: use as src "asset:${name}"`);
    }
  }
  if (imgs.length) {
    lines.push('', '## Attached images (Read each one first)', ...imgs);
    if (imageMode === 'rebuild') lines.push('Mode: REBUILD. Recreate the attached design as live animated layers (see the Images craft rule).');
    else if (imageMode === 'scene') lines.push('Mode: USE IN SCENE. Feature the image(s) as hero visuals inside the ad.');
    else lines.push('Decide from the request whether to feature the image(s) in the ad or rebuild the design as animation.');
  }
  if (auds.length) lines.push('', '## Attached audio', ...auds, 'Use it as the user describes (music bed or voiceover, kind "voice"). If it is a voiceover, duck the music volume to ~0.3 while it plays.');
  return lines.join('\n');
}

async function readValid(dir, comp) {
  let raw, errors = [];
  try { raw = JSON.parse(await readFile(join(dir, 'comp.json'), 'utf8')); errors = validateComp(raw); }
  catch (e) { errors = [`comp.json is not valid JSON: ${e.message}`]; }
  if (raw && !errors.length) { raw.width = comp.width; raw.height = comp.height; }
  return {raw, errors};
}

// Runs Claude, then repairs once if the file is invalid.
async function directAndValidate({prompt, project, dir, comp, systemPrompt, signal, onEvent, maxTurns}) {
  let result = await runClaude({prompt, sessionId: project.sessionId, dir, systemPrompt, signal, onEvent, maxTurns});
  project.sessionId = result.sessionId;
  for (let attempt = 0; ; attempt++) {
    const {raw, errors} = await readValid(dir, comp);
    if (!errors.length) return {raw, result};
    if (attempt === 1) throw Error(`The generated composition had problems: ${errors.slice(0, 4).join('; ')}`);
    onEvent({type: 'step', label: 'Fixing a few details'});
    result = await runClaude({prompt: `comp.json has these problems, fix them and keep everything else:\n- ${errors.slice(0, 12).join('\n- ')}`, sessionId: project.sessionId, dir, systemPrompt, signal, onEvent, maxTurns: 12});
    project.sessionId = result.sessionId;
  }
}

const REVIEW_PROMPT = (sheet, times, cols, failed) => `Polish pass. Read ${sheet}: a contact sheet of ${times.length} frames from the rendered video, ${cols} per row, left to right then top to bottom, at these moments:
${times.map((f, i) => `${i + 1}. ${f.t.toFixed(2)}s (${f.scene})`).join('\n')}
${failed.length ? `\nThese images failed to generate, so they show placeholders. Replace each with a non-image design (shapes, effects, UI) or a simpler prompt:\n${failed.map(f => `- layer ${f.layer}: ${f.error}`).join('\n')}\n` : ''}
Judge it like a creative director and fix real problems in comp.json with Edit: text cut off, overflowing or colliding; important things hidden or off-frame; frames that look empty or flat; weak contrast; images that look wrong for the brand (rewrite their prompt); a scene that is only text when it should show the product, an app UI, an image or an effect. Keep what works and keep scene ids. If everything already looks great, change nothing. Then reply with one short sentence for the user about what you improved (or that it was already good).`;

export async function generate({store, project, input, root, library, settings = {}, origin, token, signal, onEvent}) {
  const dir = store.dir(project.id);
  let comp = await store.loadComp(project.id);
  const fmt = FORMATS[input.format];
  if (fmt && (fmt.width !== comp.width || fmt.height !== comp.height)) {
    comp = await store.saveComp(project.id, {...comp, ...fmt});
    if (comp.scenes.length) input = {...input, prompt: `${input.prompt}\n\n(The output format just changed to ${input.format}. Re-lay out every layer for ${fmt.width}×${fmt.height}.)`};
  }
  await syncExamples(root, dir);
  const scene = input.sceneId ? comp.scenes.find(s => s.id === input.sceneId) : null;
  const systemPrompt = await buildSystemPrompt(root, library, settings);
  const prompt = await buildUserPrompt({...input, comp, scene, projectDir: dir});
  await store.snapshot(project.id, `Before: ${input.prompt.slice(0, 60)}`);
  onEvent({type: 'step', label: 'Starting Claude'});
  let {raw, result} = await directAndValidate({prompt, project, dir, comp, systemPrompt, signal, onEvent});
  let text = result.text;
  let current = normalizeComp(raw);
  let images = await resolveImages({comp: current, projectDir: dir, settings, signal, onEvent});
  current = await store.saveComp(project.id, current);

  if (settings.polish !== false && origin && current.scenes.length) {
    try {
      onEvent({type: 'step', label: 'Reviewing the frames'});
      const sheet = await renderContactSheet({comp: current, projectId: project.id, projectDir: dir, origin, token, signal});
      const before = JSON.stringify(current);
      const polished = await directAndValidate({prompt: REVIEW_PROMPT(sheet.sheet, sheet.times, sheet.cols, images.failed), project, dir, comp, systemPrompt, signal, onEvent, maxTurns: 20});
      const next = normalizeComp(polished.raw);
      if (JSON.stringify(next) !== before) {
        images = await resolveImages({comp: next, projectDir: dir, settings, signal, onEvent});
        current = await store.saveComp(project.id, next);
      }
      if (polished.result.text) text = `${text}\n\n${polished.result.text}`;
    } catch (e) {
      if (signal?.aborted) throw e;
      onEvent({type: 'step', label: `Skipped the review (${String(e.message).slice(0, 60)})`});
    }
  }
  if (images.failed.length) text += `\n\n${images.failed.length} image${images.failed.length > 1 ? 's' : ''} couldn't be generated (${images.failed[0].error}).`;
  return {text, comp: current, usage: result.usage};
}

async function syncExamples(root, dir) {
  const src = join(root, 'server', 'prompts', 'examples');
  const dst = join(dir, 'examples');
  try {
    const files = (await readdir(src)).filter(f => f.endsWith('.json'));
    await mkdir(dst, {recursive: true});
    for (const f of files) await copyFile(join(src, f), join(dst, f));
  } catch {}
}
