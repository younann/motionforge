import {open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

// Read image dimensions from file headers.
export async function imageSize(file) {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const {bytesRead} = await fh.read(buf, 0, buf.length, 0);
    const b = buf.subarray(0, bytesRead);
    if (b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return {width: b.readUInt32BE(16), height: b.readUInt32BE(20)};
    if (b.toString('ascii', 0, 3) === 'GIF') return {width: b.readUInt16LE(6), height: b.readUInt16LE(8)};
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const kind = b.toString('ascii', 12, 16);
      if (kind === 'VP8X') return {width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3)};
      if (kind === 'VP8L') { const bits = b.readUInt32LE(21); return {width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1}; }
      if (kind === 'VP8 ') return {width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff};
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return {width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5)};
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } finally { await fh.close(); }
  return null;
}

const WIN = process.platform === 'win32';
export function findBinary(name, extra = []) {
  const env = process.env[`MOTIONFORGE_${name.toUpperCase()}`];
  if (env && existsSync(env)) return env;
  const dirs = (process.env.PATH || '').split(WIN ? ';' : ':');
  for (const d of [...dirs, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', ...extra]) {
    const p = join(d, WIN ? `${name}.exe` : name);
    if (d && existsSync(p)) return p;
  }
  return null;
}

export function run(cmd, args, {timeout = 60000} = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
    let out = '', err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err = (err + d).slice(-8000); });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out) : reject(Error(err || `${cmd} exited ${code}`)); });
  });
}

export async function mediaDuration(file) {
  const ffprobe = findBinary('ffprobe');
  if (!ffprobe) return null;
  try {
    const out = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {timeout: 15000});
    const d = parseFloat(out);
    return Number.isFinite(d) ? d : null;
  } catch { return null; }
}
