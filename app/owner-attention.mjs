#!/usr/bin/env node
// owner-attention: how much of the owner's own attention went to each goal area.
// Source: interactive session transcripts only, ~/.claude/projects/*/*.jsonl (entrypoint "cli"; "sdk-cli" = headless/-p,
// skipped; subagents/ folders are never read) and ~/.codex/sessions (originator codex-tui only; codex_exec skipped).
// Owner minutes: user-typed message timestamps per session, grouped into active blocks (a gap > 10 min ends a block);
// the time from one message to the next is credited to that message's area, plus TAIL min after the last message of a block
// (reading the answer). Area = session cwd (plan folder -> goal via goal-map effort prefixes), else message content
// (plan numbers, keywords), else the previous message's area, else "factory" for harness/SuperAgent sessions in plans/.
// Results cached per file (size+mtime) in $AGENTGLIM_DATA/owner-attention-cache.json so a sync re-reads only new files.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DATA, HOME } from './paths.mjs';
export const GAP_MIN = 10, TAIL_MIN = 2;
const CACHE = `${DATA}/owner-attention-cache.json`, V = 4;
const SKIP = /^(<task-notification|<local-command|<system-reminder|This session is being continued|\[Request interrupted|Caveat:|# AGENTS\.md|<environment_context|<user_instructions|<turn_aborted)/;
const KW = [[/\b(agentglim|observatory|\bobs\b)/i, 'agentglim'], [/\bleads?\b|campaign|pilot slot/i, 'leads'], [/\baudits?\b|quick wins|\bicp\b/i, 'audits'],
  [/youtube|thumbnail|buyer video/i, 'youtube'], [/\b(qwen|ollama|strata|llama-server|local (model|worker)s?)\b/i, 'local'], [/\bclients?\b|client|client/i, 'clients']];
function areaOfCwd(cwd, inv) {
  const c = String(cwd || '').replace(/^\/home\/[^/]+/, '~');
  let m = c.match(/plans\/(\d\d)-/); if (m) return inv[m[1]] || 'other';
  if (/agentglim|plans\/_(observatory|agentglim)/.test(c)) return 'agentglim';
  if (/plans\/_run|plans\/?$/.test(c)) return null; // harness / SuperAgent (also codex worktrees of plans): decided by content
  if (/^~\/?$|^~\/dev(\/projects)?\/?$|\.codex\/worktrees\/\d+\/user/.test(c)) return undefined; // generic folder: content, else other
  if (/projects\/leads|email-sequence/.test(c)) return 'leads';
  if (/dev\/clients/.test(c)) return 'clients';
  if (/youtube|video-os|yt-/.test(c)) return 'youtube';
  if (/ai-local/.test(c)) return 'local';
  return 'other';
}
function areaOfText(t, inv) {
  const nums = [...t.matchAll(/\b(?:plans?\s*)?(\d\d)(?:-[a-z]|\b)/gi)].map((m) => m[1]).filter((n) => /plan|\d\d-[a-z]|\b\d\d\s*[/,&]/i.test(t) && +n >= 1 && +n <= 79);
  if (nums.length) { const c = {}; for (const n of nums) { const a = inv[n] || 'other'; c[a] = (c[a] || 0) + 1; } return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0]; }
  for (const [re, a] of KW) if (re.test(t)) return a;
  return null;
}
const textOf = (content) => typeof content === 'string' ? content : Array.isArray(content) ? (content.find((x) => x && (x.type === 'text' || x.type === 'input_text'))?.text || '') : '';
// one file -> [{ts, cwd, text}] of owner-typed messages (text kept short, only for area matching)
function scanClaude(f) {
  const out = []; let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { return out; }
  for (const l of txt.split('\n')) {
    if (!l.includes('"type":"user"') || !l.includes('"entrypoint":"cli"')) continue;
    let d; try { d = JSON.parse(l); } catch { continue; }
    if (d.type !== 'user' || d.entrypoint !== 'cli' || d.isMeta || d.isSidechain || d.toolUseResult) continue;
    const t = textOf(d.message?.content).trim(); if (!t || SKIP.test(t)) continue;
    out.push([Date.parse(d.timestamp), d.cwd || '', t.slice(0, 400)]);
  }
  return out;
}
function scanCodex(f) {
  const out = []; let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { return out; }
  const ls = txt.split('\n'); let meta; try { meta = JSON.parse(ls[0]).payload || {}; } catch { return out; }
  if (meta.originator !== 'codex-tui') return out;
  for (const l of ls) {
    if (!l.includes('"role":"user"')) continue;
    let d; try { d = JSON.parse(l); } catch { continue; }
    if (d.type !== 'response_item' || d.payload?.role !== 'user') continue;
    const t = textOf(d.payload.content).trim(); if (!t || SKIP.test(t)) continue;
    out.push([Date.parse(d.timestamp), meta.cwd || '', t.slice(0, 400)]);
  }
  return out;
}
function* walk(dir, depth, re) { let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) { const p = path.join(dir, e.name); if (e.isDirectory() && depth > 0 && e.name !== 'subagents') yield* walk(p, depth - 1, re); else if (e.isFile() && re.test(e.name)) yield p; } }
// returns { files, sessions, blocks (count), rawMin (sum over sessions), minutes:[[ts, {area: share of that minute}]] (deduplicated) } for messages newer than `since`
export function ownerAttention({ since = 0, inv = {}, home = HOME || os.homedir() } = {}) {
  let cache = {}; try { const c = JSON.parse(fs.readFileSync(CACHE, 'utf8')); if (c.v === V) cache = c.files; } catch {}
  const next = {}, files = [...walk(`${home}/.claude/projects`, 1, /\.jsonl$/)].map((f) => [f, scanClaude])
    .concat([...walk(`${home}/.codex/sessions`, 4, /\.jsonl$/)].map((f) => [f, scanCodex]));
  const sessions = [];
  for (const [f, scan] of files) {
    let st; try { st = fs.statSync(f); } catch { continue; } if (st.mtimeMs < since) continue;
    const k = `${st.size}:${Math.round(st.mtimeMs)}`; const msgs = cache[f]?.k === k ? cache[f].m : scan(f);
    next[f] = { k, m: msgs }; if (msgs.length) sessions.push(msgs);
  }
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(`${CACHE}.next`, JSON.stringify({ v: V, files: next })); fs.renameSync(`${CACHE}.next`, CACHE); } catch {}
  const blocks = [], spans = [];
  for (const msgs of sessions) {
    const ms = msgs.filter((m) => m[0] >= since).sort((a, b) => a[0] - b[0]); let prev = null, b = null;
    ms.forEach((m, i) => {
      const ca = areaOfCwd(m[1], inv), area = ca ?? areaOfText(m[2], inv) ?? prev ?? (ca === null ? 'factory' : 'other'); prev = area;
      if (!b || m[0] - b.end > GAP_MIN * 6e4) { b = { start: m[0], end: m[0], by: {} }; blocks.push(b); }
      const nx = ms[i + 1], span = nx && nx[0] - m[0] <= GAP_MIN * 6e4 ? (nx[0] - m[0]) / 6e4 : TAIL_MIN;
      b.by[area] = (b.by[area] || 0) + span; b.end = m[0]; spans.push([m[0], span, area]);
    });
  }
  // one owner, one clock: a wall-clock minute covered by several sessions (parallel tabs) counts once, split across their areas
  const slot = new Map();
  for (const [t, span, area] of spans) for (let k = Math.floor(t / 6e4), e = (t + span * 6e4) / 6e4; k < e; k++) { const w = Math.min(1, e - k); let m = slot.get(k); if (!m) slot.set(k, (m = {})); m[area] = Math.max(m[area] || 0, w); }
  const minutes = [];
  for (const [k, m] of slot) { const tot = Object.values(m).reduce((a, x) => a + x, 0), cap = Math.min(1, Math.max(...Object.values(m))); const by = {}; for (const [a, x] of Object.entries(m)) by[a] = cap * x / tot; minutes.push([k * 6e4, by]); }
  const raw = spans.reduce((a, x) => a + x[1], 0);
  return { files: files.length, sessions: sessions.length, blocks: blocks.length, rawMin: Math.round(raw), minutes };
}
if (fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url))) {
  let inv = {}; try { const M = JSON.parse(fs.readFileSync(`${DATA}/goals/goal-map.json`, 'utf8')); for (const [k, ps] of Object.entries(M.effort || {})) for (const p of ps) inv[p] = k; } catch {}
  const r = ownerAttention({ since: Date.now() - 28 * 864e5, inv }), by = {};
  for (const [, b] of r.minutes) for (const [a, m] of Object.entries(b)) by[a] = (by[a] || 0) + m;
  console.log(JSON.stringify({ files: r.files, sessions: r.sessions, blocks: r.blocks, rawMin: r.rawMin, wallMin: r.minutes.length, by: Object.fromEntries(Object.entries(by).map(([a, m]) => [a, Math.round(m)])) }, null, 1));
}
