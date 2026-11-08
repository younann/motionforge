import {spawnSync} from 'node:child_process';
import {findChrome} from '../server/chrome.mjs';
import {findBinary} from '../server/media.mjs';
import {homedir} from 'node:os';
import {join} from 'node:path';

const rows = [];
const check = (name, ok, detail, fix) => rows.push({name, ok, detail, fix});
const version = cmd => { const r = spawnSync(cmd, ['--version'], {encoding: 'utf8', timeout: 8000}); return r.error ? null : (r.stdout || r.stderr).split('\n')[0].trim(); };

const [major] = process.versions.node.split('.').map(Number);
check('Node.js 20+', major >= 20, process.version, 'Install Node.js 20 or newer');
const claude = process.env.MOTIONFORGE_CLAUDE_BIN || findBinary('claude', [join(homedir(), '.local/bin'), join(homedir(), '.claude/local')]);
check('Claude Code CLI', !!claude, claude ? version(claude) : 'not found', 'Install Claude Code and log in');
const ffmpeg = findBinary('ffmpeg');
check('ffmpeg (export)', !!ffmpeg, ffmpeg ? version(ffmpeg)?.slice(0, 40) : 'not found', 'macOS: brew install ffmpeg · Ubuntu: sudo apt install ffmpeg · Windows: winget install ffmpeg');
const ffprobe = findBinary('ffprobe');
check('ffprobe (audio lengths)', !!ffprobe, ffprobe || 'not found', 'Installed together with ffmpeg');
const chrome = findChrome();
check('Chrome / Chromium (export)', !!chrome, chrome || 'not found', 'Install Google Chrome, or set MOTIONFORGE_CHROME to a Chromium-based browser');

for (const r of rows) console.log(`${r.ok ? '✔' : '✘'} ${r.name.padEnd(28)} ${r.detail || ''}${r.ok ? '' : `\n    → ${r.fix}`}`);
const bad = rows.filter(r => !r.ok);
console.log(bad.length ? `\n${bad.length} problem${bad.length > 1 ? 's' : ''} found.` : '\nEverything MotionForge needs is installed.');
process.exit(bad.length ? 1 : 0);
