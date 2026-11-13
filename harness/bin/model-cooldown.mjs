#!/usr/bin/env node
// model-cooldown.mjs: skip a model the launcher just proved unavailable.
// Shared by the plans harness launcher (record) and the Jev router (filter), so a routed pick is not retried
// for cooldownMinutes() after a "model unavailable" failure.
//   node model-cooldown.mjs record OUT MODEL RC SINCE [LOG...]   append a failure row
//   node model-cooldown.mjs check PICK_JSON                      exit 1 when that pick is cooling down
// MODEL_COOLDOWN_FILE overrides the ledger and MODEL_COOLDOWN_CONFIG the {minutes} config file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN as run } from '../../app/paths.mjs'; // ledger and config live in the plans run folder, not next to this file
export const cooldownFile = () => process.env.MODEL_COOLDOWN_FILE || path.join(run, 'flags/model-cooldown.ndjson');
export function cooldownMinutes() {
  try {
    const n = JSON.parse(fs.readFileSync(process.env.MODEL_COOLDOWN_CONFIG || path.join(run, 'model-cooldown.json'), 'utf8')).minutes;
    if (Number.isFinite(n) && n >= 0) return n;
  } catch {}
  return 60;
}

// The launcher records the concrete model, while Jev names a routing option.
export function modelKey(model) {
  const m = String(model || '').toLowerCase().replace(/^(?:gofree|zen|agy):/, '').split('/').at(-1);
  const codex = m.match(/^gpt-6(?:\.1)?-(sol|astra|terra|luna)$/);
  if (codex) return `codex-${codex[1]}`;
  const claude = m.match(/^(?:claude-)?(opus|fable|sonnet|haiku)(?:-\d.*)?$/);
  if (claude) return `claude-${claude[1]}`;
  if (/^deepseek-(?:v4\.1-)?flash$/.test(m)) return 'deepseek-flash';
  if (m === 'qwen3.6-35b-a3b' || m === 'pi-local') return 'local-qwen';
  return m;
}

export function activeFailures({ file = cooldownFile(), now = Date.now(), minutes = cooldownMinutes() } = {}) {
  const active = new Map();
  let body;
  try { body = fs.readFileSync(file, 'utf8'); } catch { return active; }
  for (const line of body.split('\n')) {
    try {
      const row = JSON.parse(line), at = typeof row.at === 'number' ? row.at : Date.parse(row.at);
      if (!row.model || row.kind !== 'unavailable' || !Number.isFinite(at) || at > now || now - at >= minutes * 60000) continue;
      const key = modelKey(row.model), prev = active.get(key);
      if (!prev || at > prev.time) active.set(key, { ...row, time: at });
    } catch {} // Partial append or malformed historical row must not hide other failures.
  }
  return active;
}

export function skippedModels(rules, ids, failures = activeFailures()) {
  const skipped = [];
  for (const id of ids) {
    const launch = rules.options[id]?.launch || '';
    const concrete = launch.match(/CODEX_MODEL_OVERRIDE=['"]?([^\s'"]+)/)?.[1]
      || launch.match(/--model[=\s]+['"]?([^\s'"]+)/)?.[1];
    const row = failures.get(modelKey(id)) || (concrete && failures.get(modelKey(concrete)));
    if (row) skipped.push({ model: id, at: new Date(row.time).toISOString(), kind: row.kind, reason: row.reason });
  }
  return skipped;
}

export const cooldownTag = (skipped) => skipped.map((row) => {
  const d = new Date(row.at);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return ` | skipped ${row.model}: unavailable at ${hm}`;
}).join('');

// Match availability errors, not arbitrary HTTP failures, quota denials or task text.
const unavailable = /\bmodel(?:\s+['"`]?[^\s'"`]+['"`]?)?\s+(?:is\s+)?(?:unavailable|not\s+(?:found|available)|does\s+not\s+exist)\b|\b(?:model_not_found|model_unavailable|overloaded_error)\b|\b(?:503|529)\b.{0,100}\b(?:overload\w*|service\s+unavailable)\b|\b(?:overload\w*|service\s+unavailable)\b.{0,100}\b(?:503|529)\b/i;

function tail(file, since) {
  let fd;
  try {
    const st = fs.statSync(file);
    if (st.mtimeMs < since) return '';
    fd = fs.openSync(file, 'r');
    const size = Math.min(st.size, 65536), buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function recordFailure({ out, model, rc, since = 0, logs = ['stderr.log', 'last.txt', 'events.jsonl'], file = cooldownFile(), now = Date.now() }) {
  if (!model || !Number.isInteger(Number(rc)) || Number(rc) === 0) return null;
  for (const name of logs) {
    for (let line of tail(path.join(out, name), since).split('\n').reverse()) {
      if (name.endsWith('.jsonl')) {
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (!['error', 'turn.failed'].includes(row.type)) continue;
        line = JSON.stringify(row.error || row.message || row);
      }
      if (!unavailable.test(line)) continue;
      const row = { at: new Date(now).toISOString(), model, kind: 'unavailable', reason: line.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 400) };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
      return row;
    }
  }
  return null;
}

function main(a) {
  if (a[0] === 'record') {
    // Positional argv keeps the launcher's EXIT trap small; rc is the shell's actual exit status.
    const [, out, model, rc, since, ...logs] = a;
    const row = recordFailure({ out, model, rc, since: Number(since || 0) * 1000, ...(logs.length ? { logs } : {}) });
    if (row) console.log(`model cooldown: ${row.model}: ${row.reason}`);
    return 0;
  }
  if (a[0] === 'check') {
    const j = JSON.parse(a[1]);
    const rows = skippedModels({ options: { [j.pick]: { launch: j.launch } } }, [j.pick]);
    console.log(JSON.stringify(rows));
    return rows.length ? 1 : 0;
  }
  throw new Error('usage: model-cooldown.mjs record OUT MODEL RC SINCE [LOG...] | check PICK_JSON');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { console.error(`model-cooldown: ${e.message}`); process.exitCode = 2; }
}
