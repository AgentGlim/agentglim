// settings.mjs: harness settings for AgentGlim and the harness scripts (harness/config.mjs re-exports this file).
//   settings.defaults.json  <  user file  <  env
// User file: $AGENTGLIM_CONFIG, else $XDG_CONFIG_HOME/agentglim/harness.json, else ~/.config/agentglim/harness.json.
// Env: AGENTGLIM_PLANS, AGENTGLIM_WORK, AGENTGLIM_DATA (app/paths.mjs), AGENTGLIM_RUN (harness folder),
//      AGENTGLIM_JEV_ROUTES (Jev rules file).
// Path strings may use ~, {plans}, {run}, {agentglim} and {data}; harnessConfig() returns them expanded.
// If the Jev rules file is missing, jev-routes.example.json next to this file is used.
// CLI (for shell scripts; every printed value must be shell-safe, else exit 4), as app/settings.mjs or harness/config.mjs:
//   node settings.mjs                  the merged settings as JSON
//   node settings.mjs --get KEY        one value by dotted key: a scalar as is, a list space-separated; exit 3 when unset (null)
//   node settings.mjs --shell KEY      each non-null entry of an object as CFG_<NAME>='value' lines, for eval
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLANS, DATA } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const AGENTGLIM_ROOT = path.dirname(HERE);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => {
  if (!isObj(b)) return b === undefined ? a : b;
  const out = { ...(isObj(a) ? a : {}) };
  for (const [k, v] of Object.entries(b)) out[k] = merge(out[k], v);
  return out;
};

export function userConfigPath() {
  if (process.env.AGENTGLIM_CONFIG) return process.env.AGENTGLIM_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'agentglim', 'harness.json');
}

export function harnessConfig() {
  const defaults = readJson(path.join(HERE, 'settings.defaults.json')) || {};
  const userFile = userConfigPath();
  const user = readJson(userFile);
  const cfg = merge(defaults, user || {});
  const plans = PLANS;
  const run0 = process.env.AGENTGLIM_RUN || String(cfg.run || '{plans}/_run');
  const vars = { plans, agentglim: AGENTGLIM_ROOT, data: DATA };
  const sub = (s) => s.replace(/^~(?=\/|$)/, os.homedir()).replace(/\{(plans|run|agentglim|data)\}/g, (_, k) => vars[k]);
  vars.run = sub(run0);
  const walk = (v) => (typeof v === 'string' ? sub(v) : Array.isArray(v) ? v.map(walk) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === '_doc' ? x : walk(x)])) : v);
  const out = walk(cfg);
  out.run = vars.run;
  if (process.env.AGENTGLIM_JEV_ROUTES) out.jev = { ...out.jev, routes: process.env.AGENTGLIM_JEV_ROUTES };
  const example = path.join(HERE, 'jev-routes.example.json');
  if (out.jev && !fs.existsSync(out.jev.routes) && fs.existsSync(example)) out.jev = { ...out.jev, routes: example, example: true };
  out.roots = { plans, run: vars.run, agentglim: AGENTGLIM_ROOT, data: DATA };
  out.source = { defaults: path.join(HERE, 'settings.defaults.json'), user: userFile, userFound: !!user };
  return out;
}

const SAFE = /^[A-Za-z0-9._\/:@=+,-]+$/;
export function getKey(cfg, dotted) { return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg); }
function shellWord(v, what) {
  const s = String(v);
  if (!SAFE.test(s)) { console.error(`config: ${what} has characters a shell script can't take safely: ${JSON.stringify(s)}`); process.exit(4); }
  return s;
}

// the CLI; harness/config.mjs calls it too, so the plans link _run/bin/harness-config.mjs keeps working
export function cli(argv = process.argv.slice(2)) {
  const [cmd, key] = argv, cfg = harnessConfig();
  if (!cmd) console.log(JSON.stringify(cfg, null, 2));
  else if (cmd === '--get' && key) {
    const v = getKey(cfg, key);
    if (v == null) process.exit(3);
    if (Array.isArray(v)) console.log(v.map((x) => shellWord(x, key)).join(' '));
    else if (isObj(v)) console.log(JSON.stringify(v));
    else console.log(shellWord(v, key));
  } else if (cmd === '--shell' && key) {
    const v = getKey(cfg, key);
    if (!isObj(v)) process.exit(3);
    for (const [k, x] of Object.entries(v)) {
      if (k.startsWith('_') || x == null || isObj(x) || Array.isArray(x)) continue;
      if (!/^[A-Z][A-Z0-9_]*$/.test(k)) { console.error(`config: ${key}.${k} is not a shell variable name`); process.exit(4); }
      console.log(`CFG_${k}='${shellWord(x, `${key}.${k}`)}'`);
    }
  } else { console.error('usage: settings.mjs [--get KEY | --shell KEY]'); process.exit(2); }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
