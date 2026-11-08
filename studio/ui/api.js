const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
if (fromHash) { sessionStorage.setItem('motionforge-token', fromHash); history.replaceState(null, '', location.pathname); }
export const token = sessionStorage.getItem('motionforge-token');
const auth = () => ({authorization: `Bearer ${token}`});

export async function api(path, opts = {}) {
  const headers = {...auth(), ...(opts.body && typeof opts.body === 'string' ? {'content-type': 'application/json'} : {}), ...(opts.headers || {})};
  const res = await fetch(`/api${path}`, {...opts, headers});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error || `Request failed (${res.status})`);
  return data;
}
export const post = (path, body) => api(path, {method: 'POST', body: JSON.stringify(body || {})});
export const put = (path, body) => api(path, {method: 'PUT', body: JSON.stringify(body || {})});
export const patch = (path, body) => api(path, {method: 'PATCH', body: JSON.stringify(body || {})});
export const del = path => api(path, {method: 'DELETE'});

export async function blob(path) {
  const res = await fetch(`/api${path}`, {headers: auth()});
  if (!res.ok) throw Error(`Download failed (${res.status})`);
  return res.blob();
}

export function upload(projectId, file) {
  return api(`/projects/${projectId}/assets`, {method: 'POST', body: file, headers: {'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream'}});
}

// Streams job events; resolves with the final event.
export async function follow(jobId, onEvent) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const res = await fetch(`/api/jobs/${jobId}/events`, {headers: auth()});
      if (!res.ok) throw Error(`Event stream failed (${res.status})`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', last = null;
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        buf += dec.decode(value, {stream: true});
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const part = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!part.startsWith('data: ')) continue;
          const evt = JSON.parse(part.slice(6));
          onEvent(evt);
          if (evt.type === 'done' || evt.type === 'error') last = evt;
        }
      }
      if (last) return last;
      const st = await api(`/jobs/${jobId}`);
      if (st.status !== 'running') return [...st.events].reverse().find(e => e.type === 'done' || e.type === 'error') || {type: 'error', message: 'Job ended'};
    } catch (e) {
      if (attempt > 3) throw e;
    }
    await new Promise(r => setTimeout(r, 800));
  }
  throw Error('Lost connection to the job');
}
