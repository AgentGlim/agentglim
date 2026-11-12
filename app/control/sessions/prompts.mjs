// Prompt detection. Signals, strongest first:
//   1. Claude registry `tempo: "blocked"` or `needs` (when Claude writes them)
//   2. a pane capture matching the harness pattern pack (prompts/<harness>.json): question + options + keys
//   3. an agent-notify `needs_input` event whose agent and project (cwd basename) match and that is newer than
//      the session's last activity (the log has no pid or session id)
// A prompt carries a hash of the captured dialog; answering re-captures and refuses when the hash changed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { stripAnsi } from './transcript.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACK_DIR = path.join(HERE, '..', 'prompts');
const packs = new Map();
export function pack(harness, dir = PACK_DIR) {
  const k = `${dir}|${harness}`;
  if (!packs.has(k)) { let p = null; try { p = JSON.parse(fs.readFileSync(path.join(dir, `${harness}.json`), 'utf8')); } catch {} packs.set(k, p); }
  return packs.get(k);
}

// The hash covers the whole dialog block (rule, every context line from the block start through the last option, and
// the option labels), so a second dialog with the same question and options but a different command, file or tool
// gets a different hash and a stale click is refused (audit r1 H1).
export const hashPrompt = (question, options, context = [], rule = '') => crypto.createHash('sha256').update(JSON.stringify([rule, question, context, options.map((o) => o.label)])).digest('hex').slice(0, 16);

// one pane line -> its text without box borders and without the moving selection cursor
export function cleanLine(l) {
  return l.replace(/^\s*[│┃|]\s?/, '').replace(/\s*[│┃|]\s*$/, '').replace(/^(\s*)[❯›>→]\s/, '$1  ').trim();
}
const borderOnly = (l) => /^[\s╭╮╰╯┌┐└┘─━═┃│|]*$/.test(l);

// keys for option i (0-based) of a prompt rule
function keysFor(rule, i, m, label) {
  if (rule.key === 'digit') return [m[1]];
  if (rule.key === 'paren-or-digit') { const p = label.match(/\((esc|[a-z])\)\s*$/i); return p ? [p[1].toLowerCase() === 'esc' ? 'Escape' : p[1].toLowerCase()] : [m[1]]; }
  if (rule.key === 'arrows') return [...Array(4).fill('Left'), ...Array(i).fill('Right'), 'Enter'];
  return [m[1]];
}

// parse a captured pane (ANSI allowed) with one harness pack -> {question, options:[{label, keys}], hash, rule} | null
export function parsePane(text, harness, dir = PACK_DIR) {
  const p = pack(harness, dir); if (!p) return null;
  const lines = stripAnsi(text).split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const tail = lines.slice(-40);
  for (const rule of p.prompts || []) {
    const qre = new RegExp(rule.question, 'u');
    let qi = -1;
    for (let i = tail.length - 1; i >= 0; i--) if (qre.test(tail[i])) { qi = i; break; }
    if (qi < 0) continue;
    const question = tail[qi].match(qre)[1].trim();
    const options = [];
    let last = qi; // index of the last line that belongs to the dialog (the last option line)
    if (rule.yesNo) {
      options.push({ label: 'Yes (y)', keys: ['y'] }, { label: 'No (n)', keys: ['n'] });
    } else if (rule.option) {
      const ore = new RegExp(rule.option, 'gu');
      tail.slice(qi + 1).forEach((l, j) => {
        for (const m of l.matchAll(ore)) {
          const label = (rule.key === 'arrows' ? m[1] : `${m[1]}. ${m[2]}`).trim().slice(0, 160);
          options.push({ label, keys: keysFor(rule, options.length, m, rule.key === 'arrows' ? m[1] : m[2] || '') });
          last = qi + 1 + j;
        }
      });
    }
    if (!options.length || options.length < (rule.minOptions || 1)) continue;
    for (const x of rule.extra || []) options.push({ label: x.label, keys: [x.key] });
    // the dialog block: up to rule.above lines over the question, cut at the block's top border when the pack names one
    let first = Math.max(0, qi - (rule.above ?? 6));
    if (rule.blockStart) { const bre = new RegExp(rule.blockStart, 'u'); for (let i = qi; i >= first; i--) if (bre.test(tail[i])) { first = i; break; } }
    const context = tail.slice(first, last + 1).filter((l) => !borderOnly(l)).map(cleanLine).filter(Boolean).map((l) => l.slice(0, 240));
    return { source: 'pane', rule: rule.id, question: question.slice(0, 300), options, context: context.slice(-24), hash: hashPrompt(question, options, context, rule.id) };
  }
  return null;
}

export function makePrompts({ notifyLog = process.env.AGENT_NOTIFY_LOG || `${process.env.HOME}/.local/state/agent-notify/log.jsonl`, packDir = PACK_DIR, now = () => Date.now() } = {}) {
  let cache = { at: 0, size: -1, events: [] };
  function events() {
    let st; try { st = fs.statSync(notifyLog); } catch { return []; }
    if (st.size === cache.size && now() - cache.at < 5000) return cache.events;
    const n = Math.min(st.size, 256 * 1024), buf = Buffer.alloc(n);
    try { const fd = fs.openSync(notifyLog, 'r'); fs.readSync(fd, buf, 0, n, st.size - n); fs.closeSync(fd); } catch { return []; }
    const ev = [];
    for (const l of buf.toString('utf8').split('\n')) { if (!l.includes('"event"')) continue; try { const j = JSON.parse(l); if (j.event) ev.push({ ts: Date.parse(j.ts) || Number(j.ts) || 0, event: j.event, agent: j.agent, project: j.project }); } catch {} }
    cache = { at: now(), size: st.size, events: ev };
    return ev;
  }
  function fromRegistry(r) {
    if (r.harness !== 'claude') return null;
    if (r.tempo === 'blocked' || r.needs) {
      const q = typeof r.needs === 'string' ? r.needs : r.needs?.question || r.detail || 'Claude is waiting for input';
      return { source: 'registry', question: String(q).slice(0, 300), options: [], hash: null };
    }
    return null;
  }
  function fromNotify(r) {
    if (!r.cwd) return null;
    const project = path.basename(r.cwd);
    const mine = events().filter((e) => e.agent === r.harness && e.project === project);
    const last = mine.at(-1);
    if (!last || last.event !== 'needs_input') return null;
    if (r.lastActivity && last.ts <= r.lastActivity) return null;
    return { source: 'notify', question: 'needs input (from agent-notify; open the Terminal tab to see it)', options: [], hash: null };
  }
  async function fromPane(r, tmux) {
    if (!r.pane) return null;
    const text = await tmux.capture(r.pane, { lines: 60 });
    return parsePane(text, r.harness, packDir);
  }
  return { fromRegistry, fromNotify, fromPane, parsePane: (t, h) => parsePane(t, h, packDir), events };
}
