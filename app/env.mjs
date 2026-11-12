// env.mjs: API keys for AgentGlim, with no dependencies. Import it before anything that reads a key.
// Order, first match wins:
//   1. the process environment (your shell, the systemd unit)
//   2. <repo>/.env, or the file named by AGENTGLIM_ENV_FILE (copy .env.example to .env and fill it in)
//   3. deprecated: an `export NAME=value` line in ~/.bashrc; the first use prints a one-line note on stderr
// On import, every NAME=value in .env that the environment does not already set is copied into process.env.
//   key(name)        the value, or null
//   keySource(name)  'env' | '.env' | 'bashrc' | null (never the value itself)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ENV_FILE = process.env.AGENTGLIM_ENV_FILE || path.join(HERE, '..', '.env');
const fromFile = new Set();

export function parseEnv(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out.push([m[1], v]);
  }
  return out;
}

(function load() {
  let text; try { text = fs.readFileSync(ENV_FILE, 'utf8'); } catch { return; }
  for (const [k, v] of parseEnv(text)) if (process.env[k] === undefined && v !== '') { process.env[k] = v; fromFile.add(k); }
})();

const warned = new Set();
function fromBashrc(name) {
  if (!/^[A-Z0-9_]+$/.test(name)) return null;
  try { return fs.readFileSync(path.join(os.homedir(), '.bashrc'), 'utf8').match(new RegExp(`^export ${name}=["']?([^"'\\s]+)`, 'm'))?.[1] || null; } catch { return null; }
}

export function key(name) {
  if (process.env[name]) return process.env[name];
  const v = fromBashrc(name);
  if (v && !warned.has(name)) { warned.add(name); console.error(`agentglim: ${name} came from ~/.bashrc, which is deprecated; put it in ${ENV_FILE} (see .env.example)`); }
  return v;
}

export function keySource(name) {
  if (process.env[name]) return fromFile.has(name) ? '.env' : 'env';
  return fromBashrc(name) ? 'bashrc' : null;
}

// Ordered families, including sparse numbered keys and legacy aliases. Values stay server-side.
export function keyNames(base, aliases = [], env = process.env) {
  const names = new Set([base, ...aliases]);
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_[2-9][0-9]*$|^${base}_[1-9][0-9]+$`);
  for (const name of Object.keys(env)) if (re.test(name)) names.add(name);
  try { for (const [name] of parseEnv(fs.readFileSync(ENV_FILE, 'utf8'))) if (re.test(name)) names.add(name); } catch {}
  try { for (const [name] of parseEnv(fs.readFileSync(path.join(os.homedir(), '.bashrc'), 'utf8'))) if (re.test(name)) names.add(name); } catch {}
  return [...names].filter(n => n === base || aliases.includes(n) || re.test(n)).sort((a,b) => {
    const rank = n => n === base ? 1 : aliases.includes(n) ? 1e6 + aliases.indexOf(n) : Number(n.slice(base.length + 1));
    return rank(a) - rank(b);
  });
}
export function keyEntries(base, aliases = []) {
  return keyNames(base, aliases).map(name => ({ name, value:key(name), source:keySource(name) })).filter(x => x.value);
}
export const keys = (base, aliases = []) => keyEntries(base, aliases).map(x => x.value);
export const keyStatuses = (base, aliases = []) => keyNames(base, aliases).map(name => ({ name, set:!!keySource(name) }));
const familyCursor = new Map();
export function nextKey(base, aliases = []) {
  const list=keyEntries(base,aliases);if(!list.length)return null;
  const index=familyCursor.get(base) || 0;familyCursor.set(base,index+1);return list[index%list.length].value;
}
