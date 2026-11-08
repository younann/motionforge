import {spawn} from 'node:child_process';

const TOOLS = ['Read', 'Write', 'Edit', 'Glob'];

function describeTool(name, input = {}) {
  const file = String(input.file_path || input.path || '').split(/[\\/]/).pop();
  if (name === 'Read') return /\.(png|jpe?g|webp|gif)$/i.test(file) ? `Looking at ${file}` : `Reading ${file || 'project'}`;
  if (name === 'Write') return 'Writing the composition';
  if (name === 'Edit') return 'Refining the composition';
  if (name === 'Glob') return 'Checking project files';
  return name;
}

export async function runClaude({prompt, sessionId, dir, systemPrompt, signal, onEvent, maxTurns = 30, model, command = process.env.MOTIONFORGE_CLAUDE_BIN || 'claude'}) {
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--max-turns', String(maxTurns),
    '--permission-mode', 'acceptEdits',
    '--tools', TOOLS.join(','),
    '--allowedTools', TOOLS.join(','),
    '--strict-mcp-config',
    '--setting-sources', 'project',
    '--disable-slash-commands',
  ];
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (model || process.env.MOTIONFORGE_MODEL) args.push('--model', model || process.env.MOTIONFORGE_MODEL);
  if (sessionId) args.push('--resume', sessionId);
  const env = {...process.env};
  delete env.CLAUDECODE;
  // Prompt goes through stdin, never a shell.
  const child = spawn(command, args, {cwd: dir, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env});
  let stderr = '', buffer = '', text = '', nextSessionId = sessionId || null, reportedError = null, usage = null;
  const kill = () => child.kill('SIGTERM');
  signal?.addEventListener('abort', kill, {once: true});
  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  const completion = new Promise((resolve, reject) => {
    child.on('error', e => reject(e.code === 'ENOENT' ? Error('Claude Code CLI not found. Install it and make sure `claude` is on your PATH.') : e));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
    function receive(line) {
      if (!line.trim()) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      if (obj.session_id) nextSessionId = obj.session_id;
      if (obj.type === 'assistant' && obj.message?.content) {
        for (const c of obj.message.content) {
          if (c.type === 'text' && c.text) { text = c.text; onEvent?.({type: 'text', text}); }
          if (c.type === 'tool_use') onEvent?.({type: 'step', tool: c.name, label: describeTool(c.name, c.input)});
          if (c.type === 'thinking') onEvent?.({type: 'step', label: 'Planning the concept'});
        }
      }
      if (obj.type === 'result') {
        usage = {cost: obj.total_cost_usd ?? null, turns: obj.num_turns ?? null, ms: obj.duration_ms ?? null};
        if (obj.result && !text) { text = obj.result; onEvent?.({type: 'text', text}); }
        if (obj.is_error) reportedError = obj.result || obj.subtype || 'Claude returned an error';
        if (obj.subtype === 'error_max_turns') reportedError = 'Claude hit the turn limit before finishing.';
      }
    }
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let pos;
      while ((pos = buffer.indexOf('\n')) >= 0) { receive(buffer.slice(0, pos)); buffer = buffer.slice(pos + 1); }
    });
    child.on('close', code => {
      receive(buffer);
      if (signal?.aborted) return reject(new Error('Generation cancelled'));
      if (code !== 0 || reportedError) return reject(new Error(reportedError || stderr.trim() || `Claude exited with ${code}`));
      resolve({text, sessionId: nextSessionId, usage});
    });
  });
  try { return await completion; } finally { signal?.removeEventListener('abort', kill); }
}
