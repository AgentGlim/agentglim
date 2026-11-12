// approvals.mjs - the plans-wide review hub: every item still waiting on the owner, by project.
// Reads, never writes, the plan files; writes only data/approvals-done.json (POST /api/approvals).
// Sources:
//   NN-*/PLAN.md            "Open decisions" table rows (decided once the row says "The owner:")
//   NN-*/_build/DEFERRED.md blocker sections and ID'd table rows; owner = the item names the owner
//   NN-*/_build/VERIFY.md   bullet lines saying what the owner must do
//   NN-*/_build/<last round>/AUDIT.md   the same, for plans still building
//   HARNESS.md section 12   open harness decisions (struck-through rows are decided)
//   data/watcher-asks.json  things the watcher asked the owner in chat (the watcher keeps this file)
//   NN-*/ACTIVE + state.json  an active build waiting at its vN-gate: the owner's audit (approve / redo);
//                           the driver reads the choice from approvals-done.json (HARNESS §12 item 11)
// data/priorities.json ranks the projects (tier 1-3 + why) so the owner can work the most valuable approvals first.
// Plan pages are served read-only by servePages() on PORT+1, a separate origin, so an agent-written
// page can never call this server's write endpoints (they also refuse cross-origin POSTs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import http from 'node:http';

import { PLANS, DATA } from './paths.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DONE_FILE = `${DATA}/approvals-done.json`;
const ASKS_FILE = `${DATA}/watcher-asks.json`;
const PRIO_FILE = `${DATA}/priorities.json`;
const STAGES = ['p1', 'v1-r1', 'v1-r2', 'v1-r3', 'focus', 'v2-r1', 'v2-r2', 'v2-r3', 'verify', 'done'];

const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const slug = (s) => String(s).toLowerCase().replace(/[`*_]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
const clip = (s, n = 320) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
// Old plan docs may name the owner instead of saying "the owner": those names come from the private names file
// (one per line; AGENTGLIM_PRIVATE_NAMES_FILE, else ~/.config/agentglim/private-names.txt), shared with dev/leak-scan.mjs.
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const OWNER_NAMES = (() => {
  const f = process.env.AGENTGLIM_PRIVATE_NAMES_FILE || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agentglim', 'private-names.txt');
  try { return fs.readFileSync(f, 'utf8').split('\n').map((x) => x.trim()).filter((x) => x.length >= 3 && !x.startsWith('#')); } catch { return []; }
})();
const NAMES = OWNER_NAMES.map((n) => `${reEsc(n)}|`).join(''); // 'Name|' per name, or ''
const OWNER_RE = new RegExp(String.raw`\b(?:${NAMES}[Tt]he owner)\b`);
const ANSWER_BOLD = new RegExp(String.raw`\*\*(?:${NAMES}The owner|Owner):\s*([^*]+)\*\*`);
const ANSWER_PLAIN = new RegExp(String.raw`\b(?:${NAMES}The owner|Owner):\s*([^|]+)`);
const prioOf = (t) => (String(t).match(/\bP([0-4])\b/) || [])[1] ?? null;
const OWNER_ACT = new RegExp(String.raw`\b(?:${NAMES}the owner)(?:'s)?\s+(?:must|to do|to|should|needs?|has to|can|confirms?|decides?|applies|runs?)\b|^\s*(?:[-*]\s*)?(?:\*\*)?(?:${NAMES}the owner)(?: must| to do)?(?:\*\*)?\s*:`, 'i');

// PLAN.md decisions (2026-10-21: every format the plans use, not just "Open decisions" tables keyed D1):
//   tables in a decisions section, keyed D1 / 1 / `snake_id`, or keyed by the decision text ("Decision/risk" tables);
//   tables anywhere with an ID column and a Decision/Question column; "- `id`: text" and "1. **`id`** - text" lists.
// A row is decided when it says "The owner:" or "Owner:" (pages no longer name the owner) or is struck through. Ids stay `${dir}:dec:${slug(key)}` so done marks keep matching.
const DEC_HEAD = new RegExp(String.raw`^#{2,4} .*\b(open|unresolved|recommended)\s+decisions\b|^#{2,4} .*\bdecisions\s+(with|and|taken|for)\b|^#{2,4} .*\b(?:${NAMES}the owner)'?s decisions\b|^#{2,4} (\d+\.\s*)?decisions\s*$`, 'i');
const DEC_KEY = /^(?:D-?\d+[a-z]?|\d+|[A-Za-z][\w.-]*_[\w.-]+)$/;
const cellsOf = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
const bare = (s) => String(s || '').replace(/[*~`]/g, '').trim();
export function planDecisions(dir) {
  const txt = readText(`${PLANS}/${dir}/PLAN.md`);
  if (!txt) return [];
  const out = [], seen = new Set();
  const add = (key, title, dflt, why, line, extra = {}) => {
    const id = `${dir}:dec:${slug(key)}`;
    if (!key || seen.has(id)) return; seen.add(id);
    const said = (line.match(ANSWER_BOLD) || line.match(ANSWER_PLAIN) || [])[1];
    out.push({ id, project: dir, kind: 'decision', key, title: clip(bare(title), 160), detail: clip(`Default: ${bare(dflt)}${why ? ` · ${bare(why)}` : ''}`),
      dflt: clip(bare(dflt), 400), why: clip(bare(why), 400), answer: said ? clip(bare(said), 300) : '', decided: !!said || /^\s*\|?\s*~~/.test(line) || /\|\s*~~/.test(line),
      owner: true, src: `${dir}/PLAN.md`, ...extra });
  };
  const lines = txt.split('\n');
  let inDec = false, head = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,4} /.test(l)) { inDec = DEC_HEAD.test(l); head = null; continue; }
    if (/^\s*\|/.test(l)) {
      const c = cellsOf(l);
      if (/^\s*\|\s*:?-/.test(l)) continue;
      if (lines[i + 1] && /^\s*\|\s*:?-/.test(lines[i + 1])) { head = c.map((x) => bare(x).toLowerCase()); continue; }
      if (!head || c.length < 2) continue;
      const col = (re) => head.findIndex((h) => re.test(h));
      let k0 = bare(c[0]);
      if (/^\d+$/.test(k0) && /^[A-Za-z][\w.-]*_[\w.-]+$/.test(bare(c[1]))) { c.shift(); head = head.slice(1); k0 = bare(c[0]); }
      const kCol = col(/^(id|#|key)$/), tCol = col(/decision|question|item|choice/), dCol = col(/default|chosen|recommend/), oCol = col(/option|alternative/), wCol = col(/why|reason|consequence|later|validate/);
      let key = null, title, dflt, why, opts = '';
      if (DEC_KEY.test(k0) && (inDec || (kCol === 0 && tCol > 0))) {
        key = k0; title = tCol > 0 ? c[tCol] : dCol === 1 ? k0.replace(/_/g, ' ') : c[1]; dflt = c[dCol > 0 ? dCol : 2] || ''; why = c[wCol > 0 ? wCol : 3] || ''; opts = oCol > 0 ? bare(c[oCol]) : '';
      } else if (inDec && /^decision/.test(head[0] || '') && k0) {
        key = slug(k0).slice(0, 32); title = c[0]; dflt = c[dCol > 0 ? dCol : 1] || ''; why = c[wCol > 0 ? wCol : 2] || '';
        opts = null;
      }
      if (key) add(key, title, dflt, why, l, opts === null ? { loose: true } : opts ? { options: opts.split(/\s+\/\s+|;\s+/).map((o) => ({ v: slug(o), label: o, desc: '' })) } : {});
      continue;
    }
    head = null;
    if (!inDec) continue;
    // list items: "- `id`: question" / "1. **`id`** - text. Default: ..."
    const m = l.match(/^\s*(?:[-*]|\d+\.)\s+(?:\*\*)?`([A-Za-z][\w.-]*)`(?:\*\*)?\s*(?::|-|—|–)?\s*(.*)$/);
    if (m) {
      const rest = m[2], dm = rest.match(/\bDefault:\s*([\s\S]*)$/i);
      add(m[1], dm ? rest.slice(0, dm.index).replace(/[.\s]+$/, '') : rest, dm ? dm[1] : '', '', l);
    }
  }
  return out;
}

// The plan page's own decision list (index.html `var decs = [...]`, DEC, DECS, DECISIONS, decisions), read with a
// literal-only parser: agent-written pages are never evaluated. Each format normalizes to {key, q, why, rec, options[]}.
function literal(src, i) {
  const ws = () => { while (i < src.length) { if (/\s/.test(src[i])) i++; else if (src.startsWith('//', i)) i = src.indexOf('\n', i) + 1 || src.length; else if (src.startsWith('/*', i)) i = src.indexOf('*/', i) + 2; else break; } };
  const val = () => {
    ws(); const ch = src[i];
    if (ch === '[') { i++; const a = []; for (;;) { ws(); if (src[i] === ']') { i++; return a; } a.push(val()); ws(); if (src[i] === ',') i++; else if (src[i] !== ']') throw 0; } }
    if (ch === '{') { i++; const o = {}; for (;;) { ws(); if (src[i] === '}') { i++; return o; } let k; if (src[i] === '"' || src[i] === "'") k = val(); else { const m = src.slice(i).match(/^[\w$]+/); if (!m) throw 0; k = m[0]; i += k.length; } ws(); if (src[i++] !== ':') throw 0; o[k] = val(); ws(); if (src[i] === ',') i++; else if (src[i] !== '}') throw 0; } }
    if (ch === '"' || ch === "'" || ch === '`') { let s = ''; i++; while (src[i] !== ch) { if (i >= src.length || (ch === '`' && src[i] === '$' && src[i + 1] === '{')) throw 0; if (src[i] === '\\') { const n = src[++i]; s += n === 'n' ? '\n' : n === 'u' ? String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16)) : n; if (n === 'u') i += 4; i++; } else s += src[i++]; } i++; return s; }
    const m = src.slice(i).match(/^(-?\d+(?:\.\d+)?|true|false|null)\b/); if (!m) throw 0; i += m[0].length; return JSON.parse(m[0]);
  };
  return val();
}
const DEC_VAR = /(?:var|const|let)\s+(?:decs|DEC|DECS|DECISIONS|decisions)\s*=\s*\[/g;
export function pageDecisions(dir) {
  const html = readText(`${PLANS}/${dir}/index.html`);
  let raw = null;
  for (const m of html.matchAll(DEC_VAR)) { try { raw = literal(html, m.index + m[0].length - 1); break; } catch {} }
  if (!Array.isArray(raw)) return markupDecisions(html);
  const opt = (o) => (Array.isArray(o) ? (o.length > 1 && typeof o[0] === 'string' ? { v: o[0], label: o[1] || o[0], desc: o[2] || '' } : { v: String(o[0]), label: String(o[0]), desc: '' })
    : typeof o === 'object' && o ? { v: String(o.v ?? o.value ?? o.id ?? o.label), label: String(o.label ?? o.t ?? o.v ?? ''), desc: String(o.desc ?? o.d ?? '') } : { v: String(o), label: String(o), desc: '' });
  return raw.map((d) => {
    if (Array.isArray(d)) { // positional: [id, question, (options array | option strings...), why]
      const strs = d.filter((x) => typeof x === 'string'), arr = d.find((x) => Array.isArray(x));
      const options = arr ? arr.map(opt) : strs.slice(2, -1).filter((s, k, all) => all.indexOf(s) === k).map(opt);
      return { key: strs[0], q: strs[1] || '', why: strs.length > 2 ? strs[strs.length - 1] : '', rec: arr ? (strs[2] !== strs[strs.length - 1] ? strs[2] : options[0]?.label) : strs[2], options };
    }
    if (!d || typeof d !== 'object' || !d.id) return null;
    const options = (d.o || d.opts || d.opt || d.options || []).map(opt).filter((o) => o.v !== '' || o.label !== 'Undecided');
    let rec = d.rec ?? d.default ?? d.r ?? '';
    if (typeof rec === 'number') rec = options[rec]?.label ?? '';
    const hit = options.find((o) => o.v === rec);
    return { key: String(d.id), q: String(d.q ?? d.t ?? d.title ?? d.label ?? d.name ?? d.h ?? ''), why: String(d.why ?? d.w ?? ''), rec: hit ? hit.label : String(rec), options };
  }).filter((d) => d && d.key && d.q);
}

// static decision cards in the theme's class contract: .decision > .did, h3, p.muted, .recline, select > option
const untag = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'").replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ').trim();
function markupDecisions(html) {
  const out = [];
  for (const m of html.matchAll(/<(article|div|fieldset)\b[^>]*class="[^"]*\bdecision\b[^"]*"[^>]*>([\s\S]*?)<\/\1>(?=\s*<(?:article|div|fieldset)\b[^>]*class="[^"]*\bdecision\b|[\s\S]{0,400}?<\/(?:div|section)>)/g)) {
    const b = m[2];
    const key = untag((b.match(/class="did"[^>]*>([\s\S]*?)<\//) || b.match(/data-(?:id|choice)="([^"]+)"/) || [])[1]);
    const q = untag((b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1]);
    if (!key || !q || /\s/.test(key)) continue;
    const options = [...b.matchAll(/<option value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)].filter((o) => o[1]).map((o) => ({ v: o[1], label: untag(o[2]), desc: '' }));
    out.push({ key, q, why: untag((b.match(/<p class="muted"[^>]*>([\s\S]*?)<\/p>/) || [])[1]), rec: untag((b.match(/class="recline"[^>]*>([\s\S]*?)<\/p>/) || [])[1]).replace(/^Recommended:\s*/i, ''), options });
  }
  return out;
}

// PLAN.md rows plus the page's own list: a page decision that matches a row lends it its question and options;
// one with no row becomes its own item (same id scheme).
function decisions(dir) {
  const page = pageDecisions(dir);
  // a "Decision/risk" table with no ids mixes risks in; the page's own list wins when there is one
  const out = planDecisions(dir).filter((i) => !(i.loose && page.length));
  for (const p of page) {
    const id = `${dir}:dec:${slug(p.key)}`;
    const hit = out.find((i) => i.id === id);
    if (hit) { hit.q = p.q; hit.options = p.options; hit.rec = p.rec; if (!hit.why && p.why) hit.why = p.why; continue; }
    out.push({ id, project: dir, kind: 'decision', key: p.key, title: clip(p.q, 160), detail: clip(`Default: ${p.rec}${p.why ? ` · ${p.why}` : ''}`),
      dflt: clip(p.rec, 400), why: clip(p.why, 400), answer: '', decided: false, owner: true, src: `${dir}/index.html`, q: p.q, options: p.options, rec: p.rec });
  }
  return out;
}

// DEFERRED.md: ### sections if any, else numbered ## sections, plus table rows with an ID first cell
function deferred(dir) {
  const rel = `${dir}/_build/DEFERRED.md`, txt = readText(`${PLANS}/${rel}`);
  if (!txt) return [];
  const out = [], seen = new Set();
  const level = /^### /m.test(txt) ? '### ' : '## ';
  const parts = txt.split(new RegExp(`^(?=${level})`, 'm')).filter((p) => p.startsWith(level));
  const groupAt = (p) => { const at = txt.indexOf(p); const hs = [...txt.slice(0, at).matchAll(/^#{1,2} (.*)$/gm)]; return hs.length ? hs[hs.length - 1][1] : ''; };
  for (const p of parts) {
    const head = p.split('\n')[0].slice(level.length).trim();
    const closed = level === '### ' && /closed|resolved|fixed/i.test(groupAt(p));
    if (level === '## ' && !/^\d|^[A-Za-z]{1,10}-?\d/.test(head)) continue; // "## Active blockers" style group headings
    const body = p.split('\n').slice(1).join('\n');
    const act = body.split('\n').find((l) => OWNER_ACT.test(l)) || '';
    const id = `${dir}:def:${slug(head.split(/[.:]\s/)[0] || head)}`;
    if (seen.has(id)) continue; seen.add(id);
    out.push({ id, project: dir, kind: 'deferred', key: head.split(/[.:]\s/)[0], title: clip(head.replace(/^[\w-]+[.:]\s*/, ''), 140),
      detail: clip(act.replace(/^\s*[-*]\s*/, '') || body.split('\n').find((l) => /impact|why|what/i.test(l)) || body, 360),
      owner: OWNER_RE.test(p), prio: prioOf((body.match(/Priority[^\n]*/i) || [head])[0]) ?? prioOf(head), decided: closed, src: rel });
  }
  // table rows keyed D1 / F01 / GATE (2026-10-21: also "F01 — title" first cells and all-caps keys);
  // rows under a Closed / Resolved / Fixed heading count as decided
  let group = '';
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#{1,6} /.test(line)) { group = line; continue; }
    if (lines[i + 1] && /^\s*\|\s*:?-/.test(lines[i + 1])) continue; // header row
    const cells = cellsOf(line);
    if (cells.length < 2) continue;
    const c0 = bare(cells[0]);
    const km = c0.match(/^([A-Z]{0,3}-?\d+[a-z]?|[A-Z]{2,10})(?:\s+[—–-]\s+(.+))?$/);
    if (!km || /^(ID|P[0-4])$/.test(km[1])) continue;
    const id = `${dir}:def:${slug(km[1])}`;
    if (seen.has(id)) continue; seen.add(id);
    const title = km[2] || cells[1], rest = km[2] ? cells.slice(1) : cells.slice(2);
    out.push({ id, project: dir, kind: 'deferred', key: km[1], title: clip(bare(title), 140), detail: clip(rest.join(' · '), 300),
      owner: OWNER_RE.test(line), prio: prioOf(rest.join(' ')), decided: /closed|resolved|fixed|reconcil/i.test(group), src: rel });
  }
  return out;
}

// bullet or paragraph lines that tell the owner to do something (VERIFY.md, latest AUDIT.md)
function ownerLines(dir, rel, kind) {
  const txt = readText(`${PLANS}/${rel}`);
  if (!txt) return [];
  const out = [], seen = new Set();
  for (const raw of txt.split('\n')) {
    if (!OWNER_ACT.test(raw) || /^\s*\|/.test(raw)) continue;
    const t = raw.replace(/^\s*[-*\d.]+\s*/, '').trim();
    const id = `${dir}:${kind}:${slug(t)}`;
    if (t.length < 12 || seen.has(id)) continue; seen.add(id);
    out.push({ id, project: dir, kind, key: kind, title: clip(t, 160), detail: clip(t, 400), owner: true, src: rel });
  }
  return out;
}

function harness() {
  const txt = readText(`${PLANS}/HARNESS.md`);
  const m = txt.match(/^## 12\.[^\n]*\n([\s\S]*?)(?=^## |\Z)/m);
  if (!m) return [];
  const out = [];
  for (const line of m[1].split('\n')) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3 || !/^\d+$/.test(cells[0])) continue;
    out.push({ id: `harness:12-${cells[0]}`, project: 'harness', kind: 'harness', key: `12.${cells[0]}`,
      title: clip(cells[1].replace(/\*\*/g, ''), 140), detail: clip(cells[2]), decided: /^~~/.test(cells[1]), owner: true, src: 'HARNESS.md' });
  }
  return out;
}

function asks() {
  return readJson(ASKS_FILE, []).filter((a) => a && a.id && a.title).map((a) => ({
    id: `ask:${slug(a.id)}`, project: a.project || 'watcher', kind: 'ask', key: 'ask', title: clip(a.title, 160),
    detail: clip(a.detail || '', 500), owner: true, src: a.src || '', added: a.added || '', cmd: a.cmd || '', ...(a.prio != null ? { prio: a.prio } : {}), ...(Array.isArray(a.options) && a.options.length ? { options: a.options } : {}) }));
}

// An active build at its gate: one item asking for the owner's audit of the round (the driver acts on approve / redo).
function gateItem(dir, p) {
  if (!p || !/^v\d+-gate$/.test(p.stage || '') || !fs.existsSync(`${PLANS}/${dir}/ACTIVE`) || fs.existsSync(`${PLANS}/${dir}/HOLD`)) return [];
  const n = p.stage.slice(1, -5);
  return [{ id: `${dir}:gate:v${n}`, project: dir, kind: 'gate', key: 'gate', owner: true,
    title: `Audit the v${n} active-build round, then approve or ask for a redo`,
    detail: clip(`The round is in ${dir}/_build/v${n}-r1/ (BUILD-LOG.md has what each worker did). Approve to run the final verifier; Redo runs the round again with your notes added to BUILD-V${n}.md. Same as writing APPROVED or REDO in ${dir}/_build/v${n}-gate/.`, 500),
    src: `${dir}/_build/v${n}-gate/README.md`, cmd: `touch ~/dev/projects/plans/${dir}/_build/v${n}-gate/APPROVED` }];
}

function lastRound(dir) {
  const st = readJson(`${PLANS}/_run/state.json`, {}).projects?.[dir]?.stage;
  const i = STAGES.indexOf(st);
  for (let k = Math.min(i, STAGES.length - 2); k >= 1; k--) {
    if (fs.existsSync(`${PLANS}/${dir}/_build/${STAGES[k]}/AUDIT.md`)) return { stage: st, audit: `${dir}/_build/${STAGES[k]}/AUDIT.md` };
  }
  return { stage: st, audit: null };
}

// project -> { tier, rank, why }; unranked projects get none (the page shows them as "unranked")
export function priorities() {
  const p = readJson(PRIO_FILE, {});
  return { projects: p.projects || {}, tiers: p.tiers || {}, basis: p.basis || '', generatedAt: p.generatedAt || null };
}

let cache = { at: 0, val: null };
export function approvals(maxAgeMs = 30000) {
  if (cache.val && Date.now() - cache.at < maxAgeMs) return cache.val;
  const done = readJson(DONE_FILE, {});
  const items = [];
  const dirs = (fs.existsSync(PLANS) ? fs.readdirSync(PLANS) : []).filter((d) => /^\d\d-/.test(d) && fs.statSync(`${PLANS}/${d}`).isDirectory()).sort();
  const pages = {}, apPages = {};
  const st = readJson(`${PLANS}/_run/state.json`, {}).projects || {};
  for (const dir of dirs) {
    items.push(...gateItem(dir, st[dir]));
    if (fs.existsSync(`${PLANS}/${dir}/index.html`)) pages[dir] = `${dir}/index.html`;
    if (fs.existsSync(`${PLANS}/${dir}/approvals.html`)) apPages[dir] = `${dir}/approvals.html`; // approvals & next steps page (2026-10-21)
    items.push(...decisions(dir), ...deferred(dir), ...ownerLines(dir, `${dir}/_build/VERIFY.md`, 'verify'));
    const lr = lastRound(dir);
    if (lr.audit && lr.stage !== 'done') items.push(...ownerLines(dir, lr.audit, 'audit'));
  }
  items.push(...harness(), ...asks());
  for (const it of items) { const d = done[it.id]; it.done = !!(d && d.done) || !!it.decided; it.doneAt = d?.at || null; it.note = d?.note || ''; it.choice = d?.choice || ''; if (d?.label) it.label = d.label; }
  const byProject = {};
  for (const it of items) {
    const b = (byProject[it.project] ||= { project: it.project, open: 0, openOwner: 0, total: 0, page: pages[it.project] || null, apPage: apPages[it.project] || null });
    b.total += 1; if (!it.done) { b.open += 1; if (it.owner) b.openOwner += 1; }
  }
  cache = { at: Date.now(), val: { items, projects: Object.values(byProject), pages, apPages, priorities: priorities(), builtAt: Date.now() } };
  return cache.val;
}

export function markDone(id, isDone, note) {
  const known = approvals(0).items.some((i) => i.id === id);
  if (!known) return null;
  const done = readJson(DONE_FILE, {});
  if (isDone) done[id] = { done: true, at: new Date().toISOString(), note: String(note || '').slice(0, 500) };
  else delete done[id];
  fs.mkdirSync(path.dirname(DONE_FILE), { recursive: true });
  fs.writeFileSync(`${DONE_FILE}.tmp`, JSON.stringify(done, null, 1));
  fs.renameSync(`${DONE_FILE}.tmp`, DONE_FILE);
  cache.at = 0;
  return done[id] || { done: false };
}

// the owner's choice on an approval item, made on a plan's approvals page. Two option sets are on trial:
// 'uniform' (one set for every item) and 'kind' (a set per item kind). A closing choice marks the item done;
// the others record the owner's call and leave it open. Stored in approvals-done.json next to the done mark.
export const CHOICES = {
  uniform: { all: [['approve', 'Approve as is', 1], ['fix', 'Fix it next round', 0], ['defer', 'Defer (after this version)', 0], ['wontdo', "Won't do", 1], ['done', 'Already done', 1], ['other', 'Something else (see notes)', 0]] },
  kind: {
    deferred: [['fix', 'Fix next round', 0], ['defer', 'Defer', 0], ['wontdo', "Won't do", 1], ['done', 'Done', 1], ['other', 'Other (see notes)', 0]],
    verify: [['will', "I'll do it", 0], ['done', 'Done', 1], ['notneeded', 'Not needed', 1], ['other', 'Other (see notes)', 0]],
    audit: [['will', "I'll do it", 0], ['done', 'Done', 1], ['notneeded', 'Not needed', 1], ['other', 'Other (see notes)', 0]],
    ask: [['yes', 'Yes', 1], ['no', 'No', 1], ['other', 'Other (see notes)', 0]],
    harness: [['yes', 'Yes', 1], ['no', 'No', 1], ['other', 'Other (see notes)', 0]],
    gate: [['approve', 'Approve: run the final verifier', 1], ['redo', 'Redo the round (say what in the notes)', 1], ['other', 'Other (see notes)', 0]],
  },
};
// Decisions save the same way: the value is the page's option value (a short slug, 'approve' or
// 'other'), the label is that option's text, and any choice marks the decision done. PLAN.md stays the record:
// the watcher copies these answers into the decision table.
export function setChoice(id, choice, note, set, label) {
  const it = approvals(0).items.find((i) => i.id === id);
  if (!it) return null;
  const done = readJson(DONE_FILE, {});
  if (!choice) delete done[id];
  else if (it.kind === 'decision') {
    if (!/^[\w.-]{1,60}$/.test(choice)) return null;
    label = String(label || choice).replace(/\s+/g, ' ').trim().slice(0, 160);
    note = String(note || '').slice(0, 500);
    done[id] = { done: true, at: new Date().toISOString(), choice, label, note: `${label}${note ? `: ${note}` : ''}`, by: 'approvals page' };
  } else {
    const list = it.options ? it.options : set === 'uniform' ? CHOICES.uniform.all : set === 'kind' ? CHOICES.kind[it.kind] || CHOICES.kind.deferred : Object.values(CHOICES).flatMap((s) => Object.values(s)).flat();
    const opt = list.find((o) => o[0] === choice);
    if (!opt) return null;
    note = String(note || '').slice(0, 500);
    // note carries the label so the Observatory's Approvals list shows the call without a UI change
    done[id] = { done: !!opt[2], at: new Date().toISOString(), choice, note: `${opt[1]}${note ? `: ${note}` : ''}`, by: 'approvals page' };
  }
  fs.mkdirSync(path.dirname(DONE_FILE), { recursive: true });
  fs.writeFileSync(`${DONE_FILE}.tmp`, JSON.stringify(done, null, 1));
  fs.renameSync(`${DONE_FILE}.tmp`, DONE_FILE);
  cache.at = 0;
  return done[id] || { done: false, choice: '' };
}

// Read-only file server for plan pages on its own port (own origin). Serves files under PLANS only:
// no dot segments, no node_modules, no _run (tokens, queue), only page and text types.
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.mp4': 'video/mp4' };
export function servePages(port, onListening = () => {}) {
  let real; try { real = fs.realpathSync(PLANS); } catch { real = PLANS; } // no plans folder yet (fresh install): pages 404
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, ''); } catch { res.writeHead(400); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (!rel) rel = 'index.html';
    const segs = rel.split('/');
    const bad = segs.some((s) => !s || s.startsWith('.') || s === 'node_modules' || s === '_run' || s === 'claude-home');
    const type = TYPES[path.extname(rel).toLowerCase()];
    if (bad || !type) { res.writeHead(404); return res.end('not found'); }
    // _projects/<name>/...: the Other projects table's approvals pages (and their assets) in ~/dev/projects/<name>
    const other = segs[0] === '_projects' && segs.length > 2;
    const base = other ? path.join(path.dirname(real), segs[1]) : real;
    let file;
    try { file = fs.realpathSync(other ? path.join(base, ...segs.slice(2)) : path.join(PLANS, rel)); } catch { res.writeHead(404); return res.end('not found'); }
    if (!(file.startsWith(`${base}/`) || (!other && file.startsWith(`${path.dirname(real)}/`))) || !fs.statSync(file).isFile()) // plan folders moved out of plans/ (55, 68 into agentglim) stay reachable through their symlinks { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  }).listen(port, '127.0.0.1', () => {
    const boundPort = server.address().port;
    console.log(`plan pages on http://observatory:${boundPort} (127.0.0.1, read-only)`);
    onListening(boundPort);
  });
  return server;
}
