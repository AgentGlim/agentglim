// Skill auto-grouping (Plan 2 of the 2026-11-12 goals grill record).
//
// The daily job looks only at new or changed skills (sha256 of every copy's SKILL.md), places what it can with
// code first (TF-IDF similarity against the members already in a category, plus frontmatter, folder and name
// signals), and asks the local Strata model through `pi` for the rest. A model answer may propose a NEW category,
// but a new category is never applied by itself: it waits as an Accept/Reject chip in the Skill Editor.
// Every move is logged in the AgentGlim data folder ($AGENTGLIM_DATA/skill-group-log.ndjson) and undoable.
//
// Data (private, never in the repo):
//   $AGENTGLIM_DATA/skill-groups.json         categories, assignments, hashes, suggestions, history
//   $AGENTGLIM_DATA/skill-group-log.ndjson    append-only move log (one JSON object per line)
//
// Model access: only through the `pi` CLI, never a provider API. The local Strata model is tried first
// (pi's default provider on a local machine), then Haiku on the owner's Claude subscription. No paid API
// credit is ever used. When neither is available the job skips quietly and retries on its next run.
// Tests pass their own `ask` and never start a model.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { HOME, DATA } from './paths.mjs';
import { AGENTGLIM_ROOT } from './settings.mjs';
import { discoverSkills } from './skill-editor.mjs';
import { skillRoots } from './skills.mjs';
import { sameOriginJsonRequest } from './open-url-rules.mjs';

export const STATE_FILE = 'skill-groups.json';
export const LOG_FILE = 'skill-group-log.ndjson';
export const STATE_VERSION = 1;
const MAX_MODEL_SKILLS = 25;
const MAX_HISTORY = 200;
const MAX_MODEL_OUTPUT = 20000;

// The built-in categories. This is the one catalog the job uses; the Skill Editor page keeps the same ids and
// labels in its own inlined script so it still works without the API, and app/tests/skill-groups.test.mjs fails
// if the three copies drift apart. `other` never triggers an automatic assignment.
export const CATALOG = [
  { id: 'design', label: 'Design', rx: /design|taste|impeccable|^ui-|-ui$|ux|^theme$|brand|banner|imagegen|image-to-code|^slides$|stitch|full-output|redesign|visual|uupm/ },
  { id: 'video', label: 'Video', rx: /video|^yt-|youtube|thumbnail|short-creator/ },
  { id: 'auto', label: 'Automation', rx: /n8n|^leads|^dlt-/ },
  { id: 'review', label: 'Review', rx: /review|deslop|update-skills|competitor|skill-creator|walkthrough/ },
  { id: 'pages', label: 'Pages', rx: /human-summary|page-update|next-steps|plan-status|morning/ },
  { id: 'docs', label: 'Documents', rx: /^docs$|docx|pdf|pptx|xlsx|google-workspace/ },
  { id: 'web', label: 'Tools', rx: /browser|computer-use|deep-research|microsoft|memory|notes-mode/ },
  { id: 'writing', label: 'Writing', rx: /humanizer|linkedin|fast-output/ },
  { id: 'other', label: 'Other', rx: /./ },
];
const BUILTIN_IDS = new Set(CATALOG.map((c) => c.id));
const AUTO_MIN = 0.3; // cosine at which code alone may assign a skill
const STOP = new Set(('a an and are as at be by for from has have how i if in into is it its of on or our so that the their ' +
  'them then there these they this to use used uses using was we were what when where which who will with you your skill ' +
  'skills agent agents model models work works file files run runs').split(' '));

const NOW = () => new Date().toISOString();
const asAt = (now) => (typeof now === 'function' ? now() : now || NOW());

/* ------------------------------------------------------------------ hashing and tokens */

export function skillHash(text) {
  return createHash('sha256').update(String(text || '').replace(/\r\n/g, '\n')).digest('hex').slice(0, 40);
}

export function tokenize(text) {
  const out = [];
  for (const raw of String(text || '').toLowerCase().split(/[^a-z0-9#+]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

export function frontmatter(text) {
  const fm = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return fm;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return fm;
}

const bodyOf = (text) => String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---/, '');

/* ------------------------------------------------------------------ state and log */

const statePath = (data) => path.join(data, STATE_FILE);
const logPath = (data) => path.join(data, LOG_FILE);

export function emptyState() {
  return { version: STATE_VERSION, categories: [], assignments: {}, hashes: {}, attempts: {}, suggestions: [], rejected: {}, history: [] };
}

export function readState(data = DATA) {
  try {
    const j = JSON.parse(fs.readFileSync(statePath(data), 'utf8'));
    if (!j || typeof j !== 'object') return emptyState();
    return {
      version: STATE_VERSION,
      categories: Array.isArray(j.categories) ? j.categories.filter((c) => c && typeof c.id === 'string') : [],
      assignments: j.assignments && typeof j.assignments === 'object' ? j.assignments : {},
      hashes: j.hashes && typeof j.hashes === 'object' ? j.hashes : {},
      attempts: j.attempts && typeof j.attempts === 'object' ? j.attempts : {},
      suggestions: Array.isArray(j.suggestions) ? j.suggestions.filter((s) => s && s.id && s.label && Array.isArray(s.skills)) : [],
      rejected: j.rejected && typeof j.rejected === 'object' ? j.rejected : {},
      history: Array.isArray(j.history) ? j.history : [],
      updated: typeof j.updated === 'string' ? j.updated : null,
    };
  } catch { return emptyState(); }
}

function writeState(data, state) {
  fs.mkdirSync(data, { recursive: true });
  const tmp = path.join(data, `.${STATE_FILE}.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8' });
  fs.renameSync(tmp, statePath(data));
}

export function readLog(data = DATA) {
  try {
    return fs.readFileSync(logPath(data), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// Append-only; keeps the last 1000 rows if the file grows past 2 MB so a long-lived machine stays small.
export function appendLog(data, rows) {
  if (!rows.length) return;
  fs.mkdirSync(data, { recursive: true });
  const file = logPath(data);
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  try {
    if (fs.statSync(file).size > 2 * 1024 * 1024) {
      const keep = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-1000);
      fs.writeFileSync(file, keep.join('\n') + '\n', 'utf8');
    }
  } catch {}
}

/* ------------------------------------------------------------------ profiles */

function idfFor(docs) {
  const df = new Map();
  for (const doc of docs) for (const t of new Set(doc.tf.keys())) df.set(t, (df.get(t) || 0) + 1);
  const n = docs.length, idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log((n + 1) / (d + 1)) + 1);
  return idf;
}

function vector(tf, idf) {
  let norm = 0;
  const v = new Map();
  for (const [t, w] of tf) { const x = w * (idf.get(t) || 1); if (x) { v.set(t, x); norm += x * x; } }
  norm = Math.sqrt(norm) || 1;
  for (const [t, x] of v) v.set(t, x / norm);
  return v;
}

function cosine(a, b) {
  let s = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [t, x] of small) s += x * (big.get(t) || 0);
  return s;
}

function profile(skill) {
  const tf = new Map();
  const add = (text, w) => { for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + w); };
  add(skill.short.replace(/[-_]+/g, ' '), 3);
  add(skill.folder, 2);
  add(skill.description, 2);
  add(skill.fm.category || '', 3);
  add(skill.fm.tags || '', 3);
  add(skill.body.slice(0, 3000), 1);
  return tf;
}

export function buildProfiles(skills) {
  const docs = skills.map((s) => ({ skill: s, tf: profile(s) }));
  const idf = idfFor(docs);
  const out = new Map();
  for (const d of docs) out.set(d.skill.short, { tf: d.tf, vec: vector(d.tf, idf) });
  return { idf, bySkill: out };
}

/* ------------------------------------------------------------------ code-first placement */

// Which category a skill sits in before this run: an explicit assignment wins, then the built-in keyword rules.
export function categoryOf(short, state, catalog = CATALOG) {
  const a = state && state.assignments && state.assignments[short];
  if (a && typeof a.category === 'string') return a.category;
  for (const c of catalog) if (c.id !== 'other' && c.rx.test(short)) return c.id;
  return null;
}

// Returns { category, score, reason } when code alone is sure enough, else null (the model gets asked).
export function classifyByCode(skill, ctx) {
  const { state, profiles, catalog = CATALOG } = ctx;
  const name = skill.short.toLowerCase();
  const fmText = `${skill.fm.category || ''} ${skill.fm.tags || ''}`.toLowerCase();

  // 1. A frontmatter category or tag that names a category or one of its members.
  if (fmText.trim()) {
    for (const c of catalog) {
      if (c.id === 'other') continue;
      if (new RegExp(`\\b${c.id}\\b|\\b${c.label.toLowerCase()}\\b`).test(fmText)) return { category: c.id, score: 1, reason: 'frontmatter' };
    }
    for (const other of ctx.skills) {
      if (other.short === skill.short) continue;
      const cat = categoryOf(other.short, state, catalog);
      if (cat && cat !== 'other' && new RegExp(`\\b${other.short.replace(/[^\w-]/g, '')}\\b`).test(fmText)) return { category: cat, score: 0.95, reason: 'frontmatter' };
    }
  }

  // 2. The skill folder names the category.
  const folder = String(skill.folder || '').toLowerCase();
  if (folder) for (const c of catalog) {
    if (c.id === 'other') continue;
    if (new RegExp(`(^|[-_\\s])${c.id}([-_\\s]|$)`).test(folder) || folder.includes(c.label.toLowerCase())) return { category: c.id, score: 0.9, reason: 'folder' };
  }

  // 3. The built-in keyword rules on the folder name (what the Skill Editor already does).
  for (const c of catalog) {
    if (c.id === 'other') continue;
    if (c.rx.test(name)) return { category: c.id, score: 0.85, reason: 'keyword' };
  }

  // 4. TF-IDF similarity against members already in each category, plus name/folder tokens naming a category.
  const own = profiles.bySkill.get(skill.short);
  if (!own) return null;
  let best = null;
  for (const c of catalog.concat(state.categories || [])) {
    if (c.id === 'other' || !c.id) continue;
    const members = ctx.skills.filter((s) => s.short !== skill.short && categoryOf(s.short, state, catalog) === c.id);
    if (!members.length) continue;
    const centroid = new Map();
    for (const m of members) { const v = profiles.bySkill.get(m.short); if (!v) continue; for (const [t, x] of v.vec) centroid.set(t, (centroid.get(t) || 0) + x); }
    const score = cosine(own.vec, centroid) / Math.sqrt(members.length);
    const label = c.label ? c.label.toLowerCase() : c.id;
    const boost = new RegExp(`\\b${c.id}\\b|\\b${label}\\b`).test(`${name} ${folder}`) ? 0.2 : 0;
    const total = Math.min(1, score + boost);
    if (total >= AUTO_MIN && (!best || total > best.score)) best = { category: c.id, score: total, reason: 'similar' };
  }
  return best;
}

/* ------------------------------------------------------------------ model through pi */

const PROMPT_HEAD = [
  'You sort agent skills into categories. Reply with JSON only, no prose.',
  'Shape: {"assign":[{"skill":"<id>","category":"<existing id>"}],"create":[{"label":"<New Category>","skills":["<id>"],"reason":"<6 words>"}]}',
  'Rules: use an existing category id whenever it fits. Propose a new category only when none fits, at most 3 words,',
  'and only for skills listed below. Never invent skill ids. If nothing fits and no new category is warranted, leave those skills out.',
].join('\n');

export function buildPrompt(unplaced, state, catalog = CATALOG) {
  const cats = catalog.concat(state.categories || []).map((c) => `${c.id}=${c.label || c.id}`).join('; ');
  const rows = unplaced.slice(0, MAX_MODEL_SKILLS).map((s) => `- ${s.short}: ${String(s.description || '').slice(0, 240).replace(/\s+/g, ' ')} (folder: ${s.folder || '-'})`).join('\n');
  return `${PROMPT_HEAD}\n\nExisting categories: ${cats}\n\nUnplaced skills:\n${rows}`;
}

// Only `pi` is used: the local Strata model first, then Haiku on the owner's Claude subscription.
// Both are already paid for (local hardware / subscription), so no paid API credit is spent: API-key variables are
// removed from the child environment, so a fallback can only use the stored subscription login.
const safeEnv = (env) => {
  const e = { ...env, PI_OFFLINE: '1' };
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GOOGLE_API_KEY']) delete e[k];
  return e;
};

function runPi(args, { timeoutMs, env }) {
  return new Promise((resolve) => {
    let out = '', done = false, timer;
    let child;
    const finish = (value) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { if (child && child.exitCode === null) child.kill('SIGKILL'); } catch {}
      resolve(value);
    };
    try { child = spawn('pi', args, { env, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { return resolve(null); }
    timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    child.on('error', () => finish(null));
    child.stdout.on('data', (c) => { out += c; if (out.length > (1 << 20)) finish(null); });
    child.on('close', (code) => finish(code === 0 && out.trim() ? out.trim().slice(0, MAX_MODEL_OUTPUT) : null));
  });
}

export async function askPi(prompt, { timeoutMs = 120000, env = process.env } = {}) {
  const calls = [
    { model: 'strata', args: ['-p', '--no-session', '--no-tools', '--offline', '--provider', 'strata', prompt] },
    { model: 'haiku', args: ['-p', '--no-session', '--no-tools', '--provider', 'anthropic', '--model', 'haiku', prompt] },
  ];
  for (const call of calls) {
    const text = await runPi(call.args, { timeoutMs, env: safeEnv(env) });
    if (text) return { text, model: call.model };
  }
  return null;
}

export async function askModel(prompt) {
  if (String(process.env.AGENTGLIM_SKILL_GROUPS_MODEL || '').toLowerCase() === 'off') return null;
  return askPi(prompt);
}

const slug = (label) => String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

function jsonFrom(text) {
  const s = String(text || '').replace(/```[a-z]*\s*/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// Validate a model answer against the skills that were actually asked and the categories that exist.
export function parseModelAnswer(text, askedShorts, state, catalog = CATALOG) {
  const j = jsonFrom(text);
  if (!j || typeof j !== 'object') return null;
  const asked = new Set(askedShorts);
  const ids = new Map(); // lower-case id or label -> category id
  for (const c of catalog.concat(state.categories || [])) { ids.set(c.id.toLowerCase(), c.id); if (c.label) ids.set(String(c.label).toLowerCase(), c.id); }
  const assign = [], create = [];
  for (const row of Array.isArray(j.assign) ? j.assign : []) {
    if (!row || !asked.has(String(row.skill))) continue;
    const cat = ids.get(String(row.category || '').toLowerCase());
    if (cat) assign.push({ skill: String(row.skill), category: cat });
  }
  for (const row of Array.isArray(j.create) ? j.create : []) {
    if (!row || typeof row.label !== 'string') continue;
    const label = row.label.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 40);
    const id = slug(label);
    if (!label || !id) continue;
    if (ids.has(id) || BUILTIN_IDS.has(id)) { // a "new" category that already exists is an assignment
      for (const s of Array.isArray(row.skills) ? row.skills : []) if (asked.has(String(s))) assign.push({ skill: String(s), category: ids.get(id) || id });
      continue;
    }
    const skills = [...new Set((Array.isArray(row.skills) ? row.skills : []).map(String).filter((s) => asked.has(s)))];
    if (!skills.length) continue;
    create.push({ id, label, skills, reason: String(row.reason || '').slice(0, 120) });
  }
  return { assign, create };
}

/* ------------------------------------------------------------------ history, accept, reject, undo */

const undoable = (state) => [...(state.history || [])].reverse().find((h) => h && h.action !== 'undo' && !h.undone) || null;
const newId = () => `undo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function remember(state, entry) {
  state.history = (state.history || []).concat(entry).slice(-MAX_HISTORY);
  return entry;
}

function applyAssignment(state, skill, category, source, at) {
  const prev = state.assignments[skill] ? { ...state.assignments[skill] } : null;
  state.assignments[skill] = { category, source, at };
  state.attempts[skill] = { at, blocked: false };
  return { skill, from: prev ? prev.category : null, to: category, prev };
}

export function groupsPayload(data = DATA) {
  const state = readState(data);
  const categories = CATALOG.map((c) => ({ id: c.id, label: c.label, source: 'builtin', builtin: true }))
    .concat(state.categories.map((c, i) => ({ id: c.id, label: c.label, source: c.source || 'model', color: Number.isInteger(c.color) ? c.color : i % 8 })));
  const assignments = {};
  for (const [skill, a] of Object.entries(state.assignments)) assignments[skill] = a.category;
  const last = undoable(state);
  return {
    categories, assignments, suggestions: state.suggestions, canUndo: !!last,
    lastMove: last ? { action: last.action, skill: last.skill || null, from: last.from || null, to: last.to || null, label: last.label || null, at: last.at } : null,
    updated: state.updated || null,
  };
}

export function acceptSuggestion(id, { data = DATA, now } = {}) {
  const at = asAt(now), state = readState(data);
  const sug = state.suggestions.find((s) => s.id === id);
  if (!sug) return { ok: false, status: 404, error: 'unknown suggestion' };
  let cat = state.categories.find((c) => c.id === sug.categoryId);
  let created = false;
  if (!cat) {
    cat = { id: sug.categoryId, label: sug.label, source: 'model', created: at, color: state.categories.length % 8 };
    state.categories.push(cat); created = true;
  }
  const changes = [];
  for (const skill of sug.skills) changes.push(applyAssignment(state, skill, cat.id, 'accepted', at));
  state.suggestions = state.suggestions.filter((s) => s.id !== id);
  const entry = remember(state, { id: newId(), at, action: 'accept', suggestion: id, label: sug.label, categoryId: cat.id, createdCategory: created, changes, snapshot: sug });
  state.updated = at;
  writeState(data, state);
  appendLog(data, [...changes.map((c) => ({ at, action: 'move', skill: c.skill, from: c.from, to: c.to, source: 'accepted', suggestion: id, history: entry.id })), { at, action: 'accept', suggestion: id, label: sug.label, categoryId: cat.id, createdCategory: created, skills: sug.skills, history: entry.id }]);
  return { ok: true, status: 200, payload: groupsPayload(data) };
}

export function rejectSuggestion(id, { data = DATA, now } = {}) {
  const at = asAt(now), state = readState(data);
  const sug = state.suggestions.find((s) => s.id === id);
  if (!sug) return { ok: false, status: 404, error: 'unknown suggestion' };
  state.suggestions = state.suggestions.filter((s) => s.id !== id);
  for (const skill of sug.skills) state.rejected[`${skill}\u0001${sug.label.toLowerCase()}`] = { at, hash: state.hashes[skill] || null };
  const entry = remember(state, { id: newId(), at, action: 'reject', suggestion: id, label: sug.label, categoryId: sug.categoryId, skills: sug.skills, reason: sug.reason || '', source: sug.source || 'model' });
  state.updated = at;
  writeState(data, state);
  appendLog(data, [{ at, action: 'reject', suggestion: id, label: sug.label, skills: sug.skills, history: entry.id }]);
  return { ok: true, status: 200, payload: groupsPayload(data) };
}

export function undoLast({ data = DATA, now } = {}) {
  const at = asAt(now), state = readState(data);
  const target = undoable(state);
  if (!target) return { ok: false, status: 409, error: 'nothing to undo' };
  target.undone = true;
  const rows = [];
  if (target.action === 'accept') {
    for (const c of target.changes || []) {
      if (c.prev) state.assignments[c.skill] = { ...c.prev };
      else delete state.assignments[c.skill];
      rows.push({ at, action: 'move', skill: c.skill, from: c.to, to: c.from || null, source: 'undo' });
    }
    if (target.createdCategory) {
      const used = Object.values(state.assignments).some((a) => a.category === target.categoryId);
      if (!used) state.categories = state.categories.filter((c) => c.id !== target.categoryId);
    }
    // the chip comes back, so an accidental Accept is one undo away from the original suggestion
    if (target.snapshot && !state.suggestions.some((s) => s.id === target.suggestion)) state.suggestions.push({ ...target.snapshot, at });
  } else if (target.action === 'reject') {
    state.suggestions = state.suggestions.concat([{ id: target.suggestion, categoryId: target.categoryId, label: target.label, skills: target.skills, reason: target.reason, source: target.source || 'model', at }]);
    for (const skill of target.skills || []) delete state.rejected[`${skill}\u0001${String(target.label).toLowerCase()}`];
  } else if (target.action === 'move') {
    if (target.prev) state.assignments[target.skill] = { ...target.prev };
    else delete state.assignments[target.skill];
    rows.push({ at, action: 'move', skill: target.skill, from: target.to, to: target.from || null, source: 'undo' });
  }
  state.updated = at;
  writeState(data, state);
  appendLog(data, [{ at, action: 'undo', of: target.id, undid: target.action }, ...rows]);
  return { ok: true, status: 200, payload: groupsPayload(data), undone: target.action };
}

/* ------------------------------------------------------------------ the daily run */

function collapse(found, roots) {
  const byShort = new Map();
  for (const s of found) {
    let text = '';
    try { text = fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'); } catch {}
    let folder = '';
    for (const [, dir] of roots) {
      const real = (() => { try { return fs.realpathSync(dir); } catch { return dir; } })();
      if (folder || !s.dir.startsWith(real + path.sep)) continue;
      const rel = path.relative(real, s.dir);
      const parent = path.dirname(rel);
      folder = parent && parent !== '.' ? path.basename(parent) : '';
    }
    const cur = byShort.get(s.short);
    if (!cur) {
      byShort.set(s.short, { short: s.short, name: s.name, description: '', folder, fm: {}, body: '', copies: [{ dir: s.dir, text }] });
    } else cur.copies.push({ dir: s.dir, text });
  }
  for (const s of byShort.values()) {
    const primary = s.copies.find((c) => c.text) || { text: '' };
    const fm = frontmatter(primary.text);
    s.description = fm.description || '';
    s.fm = fm;
    s.body = bodyOf(primary.text);
    s.hash = skillHash(s.copies.map((c) => skillHash(c.text)).sort().join('\n'));
    s.folder = s.folder || '';
  }
  return [...byShort.values()].sort((a, b) => a.short.localeCompare(b.short));
}

export async function runGrouping({ home = HOME, root = AGENTGLIM_ROOT, data = DATA, ask = askModel, now, extra = [] } = {}) {
  const at = asAt(now);
  const state = readState(data);
  const roots = skillRoots({ home, root, extra });
  const skills = collapse(discoverSkills({ home, root, extra }), roots);
  const profiles = buildProfiles(skills);
  const known = new Set(skills.map((s) => s.short));
  const prune = (st) => {
    st.suggestions = st.suggestions.map((g) => ({ ...g, skills: g.skills.filter((s) => known.has(s) && !st.assignments[s]) })).filter((g) => g.skills.length);
  };

  // Only new or changed skills; a human choice (manual/accepted) is never overridden. An unplaced skill whose
  // last attempt had no model available is retried on the next run.
  const changed = skills.filter((s) => {
    const a = state.assignments[s.short];
    if (a && (a.source === 'manual' || a.source === 'accepted')) { state.hashes[s.short] = s.hash; return false; }
    if (state.hashes[s.short] === s.hash) {
      if (a) return false;
      if (state.suggestions.some((g) => g.skills.includes(s.short))) return false;
      return !!(state.attempts[s.short] && state.attempts[s.short].blocked);
    }
    return true;
  });

  const rows = [];
  const unplaced = [];
  let assigned = 0;
  for (const skill of changed) {
    const code = classifyByCode(skill, { state, skills, profiles });
    if (code) {
      state.hashes[skill.short] = skill.hash;
      const change = applyAssignment(state, skill.short, code.category, code.reason, at);
      const entry = remember(state, { id: newId(), at, action: 'move', skill: change.skill, from: change.from, to: change.to, prev: change.prev, source: code.reason });
      rows.push({ at, action: 'move', skill: change.skill, from: change.from, to: change.to, source: code.reason, score: Number(code.score.toFixed(3)), history: entry.id });
      assigned++;
    } else {
      unplaced.push(skill);
    }
  }
  const batch = unplaced.slice(0, MAX_MODEL_SKILLS);
  for (const s of unplaced.slice(MAX_MODEL_SKILLS)) state.attempts[s.short] = { at, blocked: true }; // next run

  // Commit the code-first half before the (slow) model call, so an Accept or Undo during it cannot be lost.
  prune(state);
  state.updated = at;
  writeState(data, state);
  appendLog(data, rows);

  let skipped = 0, model = null;
  const result = (st) => ({ at, scanned: skills.length, changed: changed.length, assigned, suggested: st.suggestions.length, skipped, model, payload: groupsPayload(data) });
  if (!batch.length) return result(state);

  let answer = null;
  try { answer = await ask(buildPrompt(batch, state), { skills: batch, state }); }
  catch { answer = null; } // a provider that is not installed or hangs is the same as no provider

  // Re-read: an Accept/Reject may have landed while the model was thinking.
  let next = readState(data);
  const block = (st) => { for (const s of batch) st.attempts[s.short] = { at, blocked: true }; st.updated = at; writeState(data, st); return result(st); };
  if (!answer || !answer.text) { skipped = batch.length; return block(next); }
  model = answer.model || 'model';
  const parsed = parseModelAnswer(answer.text, batch.map((s) => s.short), next);
  if (!parsed) { skipped = batch.length; return block(next); }

  const applied = [];
  const handled = new Set(parsed.assign.map((a) => a.skill));
  for (const a of parsed.assign) {
    const skill = skills.find((s) => s.short === a.skill);
    next.hashes[a.skill] = skill ? skill.hash : next.hashes[a.skill];
    const change = applyAssignment(next, a.skill, a.category, 'model', at);
    const entry = remember(next, { id: newId(), at, action: 'move', skill: change.skill, from: change.from, to: change.to, prev: change.prev, source: 'model' });
    applied.push({ at, action: 'move', skill: change.skill, from: change.from, to: change.to, source: 'model', model, history: entry.id });
    assigned++;
  }
  for (const created of parsed.create) {
    const wanted = created.skills.filter((s) => !handled.has(s));
    const fresh = wanted.filter((s) => {
      const skill = skills.find((x) => x.short === s), rej = next.rejected[`${s}\u0001${created.label.toLowerCase()}`];
      return !(rej && skill && rej.hash === skill.hash);
    });
    if (!fresh.length) continue;
    const existing = next.suggestions.find((s) => s.categoryId === created.id);
    if (existing) { existing.skills = [...new Set(existing.skills.concat(fresh))]; existing.at = at; }
    else next.suggestions.push({ id: `new-${created.id}`, categoryId: created.id, label: created.label, skills: fresh, reason: created.reason, source: 'model', at });
    for (const s of fresh) {
      const skill = skills.find((x) => x.short === s);
      next.hashes[s] = skill ? skill.hash : next.hashes[s];
      next.attempts[s] = { at, blocked: false };
      handled.add(s);
    }
    applied.push({ at, action: 'suggest', label: created.label, skills: fresh, reason: created.reason, source: 'model', model });
  }
  for (const s of batch) if (!handled.has(s.short)) {
    next.hashes[s.short] = s.hash;
    next.attempts[s.short] = { at, blocked: false };
  }
  prune(next);
  next.updated = at;
  writeState(data, next);
  appendLog(data, applied);
  return result(next);
}

/* ------------------------------------------------------------------ HTTP route for the editor */

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
  return true;
};

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let body = '', over = false;
    req.on('data', (c) => { if (over) return; body += c; if (body.length > limit) { over = true; body = ''; req.destroy(); } });
    req.on('end', () => resolve(over ? null : body));
  });
}

// GET /api/skills/groups -> editor payload; POST accept|reject|undo -> updated payload (same-origin JSON only).
export async function skillGroupsRoute(req, res, route, { data = DATA } = {}) {
  if (!route.startsWith('/api/skills/groups')) return false;
  if (route === '/api/skills/groups' && req.method === 'GET') return json(res, 200, groupsPayload(data));
  if (!['/api/skills/groups/accept', '/api/skills/groups/reject', '/api/skills/groups/undo'].includes(route)) {
    if (route === '/api/skills/groups') return json(res, 405, { error: 'GET only' });
    return json(res, 404, { error: 'not found' });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  if (!sameOriginJsonRequest(req)) return json(res, 403, { error: 'forbidden' });
  const raw = await readBody(req);
  if (raw == null) return json(res, 413, { error: 'too large' });
  let body; try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
  let out;
  if (route.endsWith('/accept')) out = acceptSuggestion(typeof body.id === 'string' ? body.id : '', { data });
  else if (route.endsWith('/reject')) out = rejectSuggestion(typeof body.id === 'string' ? body.id : '', { data });
  else out = undoLast({ data });
  if (!out.ok) return json(res, out.status || 400, { error: out.error });
  return json(res, 200, out.payload);
}
