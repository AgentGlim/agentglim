// control.json: owner-editable settings for the Control module. Created with safe defaults on first use.
// liveSend ships false: every send, key, signal and launch path refuses (409 live_send_off) while it is false.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();

export const DEFAULTS = Object.freeze({
  liveSend: false,
  peer: { enabled: false },
  watcher: { names: ['watcher', 'plans-*'], cwd: path.join(HOME, 'dev', 'projects', 'plans') },
  launch: {
    tmuxSession: 'obs',
    roots: [path.join(HOME, 'dev', 'projects')],
    claude: { bin: 'claude', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'], modes: ['manual', 'acceptEdits', 'plan', 'auto'] },
    codex: { bin: 'codex', models: ['gpt-6.1-sol'], efforts: ['low', 'medium', 'high'] },
    pi: { bin: path.join(HOME, '.local', 'bin', 'pi'), models: [], thinking: ['off', 'low', 'medium', 'high'] },
    opencode: { bin: path.join(HOME, '.local', 'bin', 'opencode'), models: [] },
  },
  remote: { enabled: false, port: 19100, host: null, allowLogins: [], requireTailscaleLogin: true, devInsecure: false },
  push: { subject: 'mailto:owner@localhost', types: { needs_input: true, watcher_reply: true, watcher_ask: true, plan_done: true, audit_score: true, gate_waiting: true, blocked: true, driver_down: true, usage_limit: true } },
  app: { packageId: 'app.agentglim.observatory', versionCode: 1 },
  opsEvents: { enabled: false },
});

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function merge(base, over) {
  if (!isObj(over)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : structuredClone(v);
  return out;
}

// bypassPermissions is never offered, whatever the file says
const sanitize = (c) => {
  c.liveSend = c.liveSend === true;
  c.peer.enabled = c.peer.enabled === true;
  if (c.launch?.claude?.modes) c.launch.claude.modes = c.launch.claude.modes.filter((m) => m !== 'bypassPermissions');
  return c;
};

export function makeConfig(dataDir) {
  const file = path.join(dataDir, 'control.json');
  let cache = null, cacheM = -1;
  function load() {
    let st = null; try { st = fs.statSync(file); } catch {}
    if (!st) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2) + '\n', { mode: 0o600 });
      st = fs.statSync(file);
    }
    if (cache && st.mtimeMs === cacheM) return cache;
    let raw = {}; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { raw = {}; }
    cache = sanitize(merge(DEFAULTS, raw)); cacheM = st.mtimeMs;
    return cache;
  }
  function save(patch) {
    const cur = load();
    let raw = {}; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const next = merge(raw, patch);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    cache = null; void cur;
    return load();
  }
  return { file, load, get: load, save, liveSend: () => load().liveSend === true };
}
