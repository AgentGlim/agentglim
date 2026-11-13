#!/usr/bin/env node
// harness-set.mjs: harness settings the app may change, applied by the watcher through the run-modes queue.
//   node harness-set.mjs keys                         every key with its current value (JSON)
//   node harness-set.mjs check KEY VALUE              exit 0 when VALUE is valid for KEY, else exit 2 with the reason
//   node harness-set.mjs set KEY VALUE [--by NAME]    apply it and print what changed
// Keys:
//   jev.close         Jev tie margin: within this of the top score the stronger option wins. 0 to 0.2, two decimals at most.
//   jev.notifyPicks   options whose pick sends a desktop ping: comma-separated option ids from the rules file, or "none".
// Flow: Harness page -> POST /api/harness-setting -> modes.mjs request (mode_queue) -> the watcher wakes on MODE: and runs
// modes.mjs apply-queue -> modes.mjs hands jev.* keys to this script. The harness keeps a link at <run>/bin/harness-set.mjs.
// Each change is appended to <data>/harness-settings.ndjson with the old and new value; the rules file before the change
// is kept as <rules>.bak-prev.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessConfig } from '../config.mjs';

const cfg = harnessConfig();
const FILE = cfg.jev.routes, LOG = path.join(cfg.roots.data, 'harness-settings.ndjson');
const readRules = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));

export const KEYS = {
  'jev.close': {
    get: (r) => r.close,
    parse: (v) => {
      if (!/^(0(\.\d{1,2})?|\.\d{1,2})$/.test(v)) throw new Error('jev.close must be a number from 0 to 0.2 with at most two decimals');
      const n = Number(v); if (n > 0.2) throw new Error('jev.close must be 0.2 or less'); return n;
    },
    apply: (text, n) => text.replace(/("close"\s*:\s*)[0-9.]+/, `$1${n}`),
  },
  'jev.notifyPicks': {
    get: (r) => r.notify?.picks || [],
    parse: (v, r) => {
      if (v === 'none' || v === '') return [];
      const ids = v.split(',').map((x) => x.trim()).filter(Boolean), known = Object.keys(r.options || {});
      const bad = ids.filter((x) => !known.includes(x));
      if (bad.length) throw new Error(`jev.notifyPicks: unknown option ${bad.join(', ')}`);
      return [...new Set(ids)];
    },
    apply: (text, list) => text.replace(/("notify"\s*:\s*\{[^{}]*?"picks"\s*:\s*)\[[^\]]*\]/, `$1${JSON.stringify(list).replaceAll(',', ', ')}`),
  },
};

export function check(key, value) {
  const k = KEYS[key]; if (!k) throw new Error(`unknown harness key ${key} (known: ${Object.keys(KEYS).join(', ')})`);
  return k.parse(String(value ?? ''), readRules());
}

export function set(key, value, by = 'watcher') {
  const k = KEYS[key], v = check(key, value), text = fs.readFileSync(FILE, 'utf8'), r = JSON.parse(text), old = k.get(r);
  if (JSON.stringify(old) === JSON.stringify(v)) return { changed: false, old, value: v };
  let next = k.apply(text, v), parsed;
  try { parsed = JSON.parse(next); } catch { parsed = null; }
  if (!parsed || JSON.stringify(k.get(parsed)) !== JSON.stringify(v)) { // pattern missed: write the whole object instead
    const o = JSON.parse(text);
    if (key === 'jev.close') o.close = v; else o.notify = { ...(o.notify || {}), picks: v };
    next = JSON.stringify(o, null, 2) + '\n';
  }
  fs.copyFileSync(FILE, `${FILE}.bak-prev`);
  fs.writeFileSync(`${FILE}.next`, next); fs.renameSync(`${FILE}.next`, FILE);
  try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), key, old, value: v, by, file: FILE }) + '\n'); } catch {}
  return { changed: true, old, value: v };
}

export const values = () => { const r = readRules(); return Object.fromEntries(Object.entries(KEYS).map(([k, x]) => [k, x.get(r)])); };

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), [cmd, key, value] = a, i = a.indexOf('--by'), by = i >= 0 ? a[i + 1] : 'watcher';
  try {
    if (cmd === 'keys') console.log(JSON.stringify({ file: FILE, values: values() }, null, 2));
    else if (cmd === 'check') { check(key, value); console.log('ok'); }
    else if (cmd === 'set') { const r = set(key, value, by); console.log(r.changed ? `applied: ${key} ${JSON.stringify(r.old)} -> ${JSON.stringify(r.value)}` : 'no change'); }
    else { console.error('usage: harness-set.mjs keys | check KEY VALUE | set KEY VALUE [--by NAME]'); process.exit(2); }
  } catch (e) { console.log(e.message); process.exit(2); }
}
