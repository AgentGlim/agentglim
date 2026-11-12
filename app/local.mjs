// Local status section (ai-local FINAL-DEFAULTS-WATCHER.md).
// Config values come only from ai-local's manual defaults; active agents are observed
// (live `local-pilot.py run` leases), never assumed from allocated slots.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { PROJECTS } from './paths.mjs';
import { listProcesses } from './proc.mjs';

const MODES = `${PROJECTS}/ai-local/servers/local-subagent-modes.json`;
const rj = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// node:http, one connection per probe (2026-11-06): with fetch(), llama-server's Connection: close on every 100th
// keep-alive request raced undici's parser (assert(!this.paused)) and crashed the server; see undici-guard.mjs
const getJson = (url, ms) => new Promise((ok) => {
  const q = http.get(url, { agent: false, timeout: ms }, (r) => {
    let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; }); r.on('error', () => ok(null));
    r.on('end', () => { if (r.statusCode !== 200) return ok(null); try { ok(JSON.parse(b)); } catch { ok(null); } });
  });
  q.on('timeout', () => q.destroy(new Error('timeout'))); q.on('error', () => ok(null));
});

export function activeAgents() {
  return listProcesses().filter(({ args }) => args[1]?.endsWith('local-pilot.py') && args[2] === 'run').length;
}

export async function localStatus(RUN) {
  const modes = rj(MODES) || { models: {} };
  const sel = modes.selected_model;
  const st = rj(`${RUN}/flags/qwen-pilot-state.json`) || {};
  const sw = rj(`${RUN}/flags/local-switch.json`);
  let slots = null;
  slots = await getJson('http://127.0.0.1:8096/slots', 2500);
  const fresh = st.at && Date.now() / 1000 - st.at < 20;
  const paused = fs.existsSync(`${RUN}/flags/qwen-pilot-paused`);
  const enabled = fs.existsSync(`${RUN}/flags/qwen-pilot-enabled`);
  const onDemand = fs.existsSync(`${RUN}/flags/qwen-pilot-ondemand`);
  const active = activeAgents();
  let server = 'stopped';
  if (sw && ['draining', 'stopping', 'starting'].includes(sw.state) && Date.now() / 1000 - sw.at < 4 * 3600) server = sw.state === 'draining' ? 'paused' : 'starting';
  else if (!enabled) server = 'blocked';
  else if (fresh && st.ready && slots) server = paused ? 'paused' : active ? 'ready' : 'idle';
  else if (fresh && !st.ready) server = 'starting';
  else if (st.reason && (fresh || !onDemand)) server = 'blocked'; // a stale reason on a sleeping on-demand pilot is not a block
  else if (onDemand && !active) server = 'on-demand'; // asleep but enabled; on-demand pilot not yet woken
  const prof = modes.models[st.model || sel] || modes.models[sel] || {};
  // Use the config value (114688 = 112K) not the modes override (118784 = 116K)
  const cfg = rj(`${PROJECTS}/ai-local/servers/local-subagents.json`);
  const ctxTokens = cfg?.context_per_worker_tokens || prof.context_per_worker_tokens;
  return {
    server, model: st.model || sel, selected: sel, label: prof.label, runtime: prof.runtime,
    context_per_worker_tokens: ctxTokens, max: prof.max_concurrent_workers, active,
    observed_slots: slots ? slots.map((s) => ({ id: s.id, n_ctx: s.n_ctx, busy: s.is_processing })) : null,
    gpu_free_mib: st.gpu_free_mib, pid: st.pid, reason: st.reason || null, switch: sw,
    options: Object.entries(modes.models).map(([id, m]) => ({ id, label: m.label })),
  };
}

export function localSwitch(RUN, model) {
  const modes = rj(MODES) || { models: {} };
  if (!modes.models[model]) return { ok: false, error: 'unknown model' };
  if (!fs.existsSync(`${RUN}/bin/local-switch.py`)) return {ok:false,error:'Local switching add-on is not installed'};
  fs.mkdirSync(`${RUN}/flags`,{recursive:true});
  const p = spawn('python3', [`${RUN}/bin/local-switch.py`, model], { detached: true, stdio: ['ignore', fs.openSync(`${RUN}/flags/local-switch.log`, 'a'), fs.openSync(`${RUN}/flags/local-switch.log`, 'a')] });
  p.on('error',()=>{});p.unref();
  return { ok: true, started: true, model };
}
