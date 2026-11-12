// Skills to retire: live recommendation payload for the Skill Editor's retire page.
// Reads the same discovered skills as /api/skills/list plus $AGENTGLIM_DATA/skills-usage.json, and optional
// owner notes from $AGENTGLIM_DATA/skills-retire.json (old shape {"skills":{id:{what,src}}}; a plain string works too).
// Recommends only: nothing here moves, deletes or edits a skill.
//   GET /api/skills/retire -> {generated, counts, skills:[...]} (data.json shape, unversioned)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HOME, DATA } from './paths.mjs';
import { AGENTGLIM_ROOT } from './settings.mjs';
import { discoverSkills, skillsPayload } from './skill-editor.mjs';

const DAY = 86400000;
const WEEKS = 8;
const STRONG = ['routes', 'runs', 'reads', 'files'];
const KIND_ORDER = ['routes', 'runs', 'reads', 'files', 'variant', 'contrast', 'mentions'];
const KIND_LABEL = { routes: 'hands off to', runs: 'runs', reads: 'reads', files: 'uses files of', variant: 'variant of', contrast: 'says not to use', mentions: 'mentions' };
const GENERIC = new Set(['design', 'docs', 'pdf', 'theme', 'leads']);

// Same categories as the Skill Editor page, so a retire row uses the same colour dot as the editor.
export const CATS = [
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

export const GROUP_LABELS = { remove: 'Remove', merge: 'Merge', watch: 'Keep but watch', keep: 'Keep' };

export function catOf(id) {
  for (const c of CATS) if (c.rx.test(id)) return c.id;
  return 'other';
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const daysSince = (d, today) => (d ? Math.max(0, Math.round((today - new Date(d)) / DAY)) : null);
const labelOf = (s) => {
  if (s.scope !== 'global') return s.project || 'project';
  if (s.root === 'claude') return 'Claude only';
  if (s.root === 'agents') return 'global';
  return s.root || 'global';
};

function readJson(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

// Old page's "what it does" fallback: the first sentence, at most 120 characters.
export function shorten(text) {
  let t = String(text || '').replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  let first = (t.match(/^.*?[.!?](?=\s|$)/) || [t])[0].replace(/\s*\(.*?\)/g, '');
  if (first.length > 120) first = `${first.slice(0, 117).replace(/[\s,;:]+\S*$/, '')}...`;
  return first;
}

function descriptionFrom(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const d = m && /^description:\s*(.*(?:\r?\n[ \t]+.*)*)/m.exec(m[1]);
    if (!d) return '';
    return d[1].replace(/^[>|]-?\s*/, '').replace(/\s+/g, ' ').replace(/^["']|["']$/g, '').trim();
  } catch { return ''; }
}

// Old page's weekly sparkline input: usage.days is {YYYY-MM-DD: count}; absent in newer usage files.
function weeksOf(days, today) {
  if (!days || typeof days !== 'object') return null;
  const out = new Array(WEEKS).fill(0);
  for (const [d, n] of Object.entries(days)) {
    const w = Math.floor((today - new Date(`${d}T00:00:00Z`)) / (7 * DAY));
    if (w >= 0 && w < WEEKS && Number.isFinite(+n)) out[WEEKS - 1 - w] += +n;
  }
  return out;
}

function logStart(usage) {
  const froms = Object.values(usage.range || {}).map((r) => r && r.from).filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
  if (froms.length) return froms[0].slice(0, 10);
  const days = [];
  for (const u of Object.values(usage.skills || {})) for (const d of Object.keys((u && u.days) || {})) days.push(d);
  return days.filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d)).sort()[0] || null;
}

// The recommendation rules and reason text from the standalone page's build.mjs.
export function buildRetireData({ skills, usage = {}, notes = {}, today = Date.now() } = {}) {
  const usageSkills = usage && typeof usage.skills === 'object' ? usage.skills : {};
  const noteMap = notes && typeof notes === 'object'
    ? (notes.skills && typeof notes.skills === 'object' ? notes.skills : notes) : {};
  const logFrom = logStart(usage || {});
  const logDays = logFrom ? daysSince(logFrom, today) : null;
  const noUse = logFrom ? `No recorded use since logs began ${logFrom}` : 'No recorded use in the usage log';

  const out = skills.map((s) => {
    const u = usageSkills[s.id] || {};
    const num = (v) => (Number.isFinite(+v) ? +v : 0);
    const copies = (s.copies || []).map((c) => ({ ...c, delta: c.delta || 0 }));
    const note = noteMap[s.id];
    const noteText = typeof note === 'string' ? note : note && typeof note.what === 'string' ? note.what : '';
    const inStrong = Object.entries(s.inn || {}).filter(([, k]) => STRONG.includes(k))
      .map(([from, kind]) => ({ from, kind, verb: KIND_LABEL[kind] || kind }));
    const inMention = Object.entries(s.inn || {}).filter(([, k]) => !STRONG.includes(k)).map(([from]) => from);
    const outs = Object.entries(s.out || {}).filter(([, k]) => k !== 'mentions').map(([to, kind]) => ({ to, kind }));
    const hashes = new Set(copies.map((c) => c.hash).filter(Boolean));
    const changed = copies.map((c) => c.mtime).filter(Boolean).sort().pop() || null;
    const born = copies.map((c) => c.born).filter(Boolean).sort()[0] || null;
    return {
      id: s.id, cat: s.cat || catOf(s.id), catLabel: (CATS.find((c) => c.id === (s.cat || catOf(s.id))) || {}).label,
      desc: s.desc || '', what: noteText || shorten(s.desc || ''), manual: !!s.manual, lines: copies[0] ? copies[0].lines : 0,
      uses: num(u.total), calls: num(u.calls), typed: num(u.typed), loads: num(u.loads), agents: u.agents && typeof u.agents === 'object' ? u.agents : {},
      last: typeof u.last === 'string' ? u.last : null, sinceLast: daysSince(u.last, today), weeks: weeksOf(u.days, today),
      inStrong, inMention, out: outs, copies, diverged: hashes.size > 1, changed, sinceChanged: daysSince(changed, today), born, age: daysSince(born, today),
    };
  });
  const by = Object.fromEntries(out.map((s) => [s.id, s]));

  // A skill that overlaps another (variant link, or one name extends the other).
  function siblings(s) {
    const found = [];
    for (const o of out) {
      if (o.id === s.id) continue;
      if (STRONG.includes((s.out.find((x) => x.to === o.id) || {}).kind)) continue; // a skill that calls another is its parent
      const prefix = (s.id.startsWith(`${o.id}-`) && !GENERIC.has(o.id)) || (o.id.startsWith(`${s.id}-`) && !GENERIC.has(s.id));
      const lookup = s.id.endsWith('-lookup') && (o.id === s.id.replace(/-lookup$/, '') || (s.id === 'uupm-lookup' && o.id === 'ui-ux-pro-max'));
      if (prefix || lookup) found.push({ id: o.id, uses: o.uses, why: lookup ? 'lookup copy of' : 'same family as' });
    }
    return found.sort((a, b) => b.uses - a.uses);
  }

  for (const s of out) {
    const sib = siblings(s);
    const usedCallers = s.inStrong.filter((x) => by[x.from] && by[x.from].uses > 0);
    s.siblings = sib.slice(0, 3);
    s.safe = s.inStrong.length ? 'blocked' : s.inMention.length ? 'check' : 'safe';
    s.safeText = s.inStrong.length
      ? `${plural(s.inStrong.length, 'skill')} call${s.inStrong.length === 1 ? 's' : ''} or read${s.inStrong.length === 1 ? 's' : ''} it: ${s.inStrong.slice(0, 3).map((x) => x.from).join(', ')}${s.inStrong.length > 3 ? '...' : ''}`
      : s.inMention.length
        ? `Nothing calls it; ${plural(s.inMention.length, 'skill')} mention the name: ${s.inMention.slice(0, 3).join(', ')}`
        : 'Nothing links to it';
    const recent = s.age != null && s.age < 14;
    const better = sib.find((o) => o.uses > s.uses);
    let group, reason, into = null;
    if (s.uses === 0 && !s.inStrong.length && !recent) {
      group = 'remove';
      reason = better ? `${noUse}. Nothing calls it, and ${better.id} (${plural(better.uses, 'use')}) covers the same ground.`
        : `${noUse}, and no other skill calls it.`;
    } else if (s.uses <= 3 && better && better.uses >= 3) {
      group = 'merge'; into = better.id;
      reason = `${s.uses ? `Only ${plural(s.uses, 'use')}` : 'Never used'}, while ${better.id} gets ${plural(better.uses, 'use')}. Fold anything unique into ${better.id}.`;
    } else if (s.diverged && s.uses <= 3) {
      group = 'merge';
      const odd = s.copies.filter((c) => c.delta);
      reason = `${s.uses ? `Only ${plural(s.uses, 'use')}, and its` : 'Never used, and its'} ${s.copies.length} copies differ: ${odd.map((c) => `${c.label} has ${plural(c.delta, 'changed line')}`).join(', ')}. Keep the ${s.copies[0].label} copy and drop or sync the others.`;
    } else if (s.uses === 0 && s.inStrong.length) {
      group = 'watch';
      const c0 = usedCallers[0] || s.inStrong[0];
      reason = `Never run directly, but ${c0.from}${by[c0.from] && by[c0.from].uses ? ` (${plural(by[c0.from].uses, 'use')})` : ''} ${c0.verb} it. Removing it would break that link.`;
    } else if (s.uses === 0 && recent) {
      group = 'watch'; reason = `Added ${plural(s.age, 'day')} ago and not used yet. Give it a few weeks.`;
    } else if (s.uses <= 3) {
      group = 'watch'; reason = `Only ${plural(s.uses, 'use')}, last on ${s.last || 'an unknown date'}. Check again next month.`;
    } else {
      group = 'keep'; reason = `${plural(s.uses, 'use')}, last on ${s.last || 'an unknown date'}.${s.diverged ? ` Its ${s.copies.length} copies differ (${s.copies.filter((c) => c.delta).map((c) => c.label).join(', ')}); sync them.` : ''}`;
    }
    s.group = group; s.reason = reason; s.into = into;
  }

  const order = ['remove', 'merge', 'watch', 'keep'];
  return {
    generated: new Date(today).toISOString(), logFrom, logDays,
    usageBuilt: usage.generated || null, sources: usage.sources || null, method: usage.method || null, weeks: WEEKS,
    counts: Object.fromEntries(order.map((g) => [g, out.filter((s) => s.group === g).length])),
    copiesTotal: out.reduce((n, s) => n + s.copies.length, 0), skillsTotal: out.length,
    cats: CATS.filter((c) => out.some((s) => s.cat === c.id)).map((c) => ({ id: c.id, label: c.label })),
    skills: out.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.uses - b.uses ||
      (b.sinceLast ?? 999) - (a.sinceLast ?? 999) || a.id.localeCompare(b.id)),
  };
}

// Group the API's per-copy skill records the same way the Skill Editor does (one group per short name).
function prepare(payload, dirs) {
  const groups = new Map();
  const byName = new Map();
  for (const s of payload) {
    byName.set(s.name, s);
    let g = groups.get(s.short);
    if (!g) { g = { id: s.short, desc: '', cat: catOf(s.short), copies: [], out: {}, inn: {} }; groups.set(s.short, g); }
    const real = dirs.get(s.name) || s.dir;
    let text = '', st = null;
    try { text = fs.readFileSync(path.join(real, 'SKILL.md'), 'utf8'); st = fs.statSync(path.join(real, 'SKILL.md')); } catch {}
    g.copies.push({
      label: labelOf(s), dir: s.dir, lines: s.lines || 0,
      hash: text ? createHash('sha1').update(text).digest('hex').slice(0, 10) : null,
      mtime: st ? isoDay(st.mtime) : null,
      born: st ? isoDay(st.birthtimeMs ? st.birthtime : st.mtime) : null,
      _real: real, _text: text,
    });
    if (!g.desc && s.description) g.desc = s.description;
    if (!g.manual && s.manual) g.manual = true;
  }
  for (const g of groups.values()) {
    // Same primary-copy order as the editor: global copies first, then project copies, then by name.
    g.copies.sort((a, b) => (a.label === 'global' ? 0 : a.label === 'Claude only' ? 1 : 2) - (b.label === 'global' ? 0 : b.label === 'Claude only' ? 1 : 2) || a.dir.localeCompare(b.dir));
    const base = new Map();
    (g.copies[0] ? g.copies[0]._text : '').split('\n').forEach((line) => base.set(line, (base.get(line) || 0) + 1));
    g.copies.forEach((c, i) => {
      if (!i) { c.delta = 0; return; }
      let d = 0;
      for (const line of c._text.split('\n')) { const n = base.get(line); if (n) base.set(line, n - 1); else d++; }
      c.delta = d;
    });
    if (!g.desc && g.copies[0]) g.desc = descriptionFrom(g.copies[0]._real);
    for (const c of g.copies) { delete c._real; delete c._text; }
  }
  const best = new Map();
  for (const s of payload) {
    for (const l of s.links || []) {
      const t = byName.get(l.to);
      if (!t || t.short === s.short) continue;
      const kind = KIND_ORDER.includes(l.kind) ? l.kind : 'mentions';
      const key = `${s.short}\u0001${t.short}`, cur = best.get(key);
      if (!cur || KIND_ORDER.indexOf(kind) < KIND_ORDER.indexOf(cur.kind)) best.set(key, { from: s.short, to: t.short, kind });
    }
  }
  for (const e of best.values()) {
    groups.get(e.from).out[e.to] = e.kind;
    groups.get(e.to).inn[e.from] = e.kind;
  }
  return [...groups.values()];
}

export function retirePayload({ home = HOME, root = AGENTGLIM_ROOT, data = DATA, extra, today = Date.now() } = {}) {
  const payload = skillsPayload({ home, root, extra });
  const dirs = new Map(discoverSkills({ home, root, extra }).map((s) => [s.name, s.dir]));
  return buildRetireData({
    skills: prepare(payload, dirs),
    usage: readJson(path.join(data, 'skills-usage.json')),
    notes: readJson(path.join(data, 'skills-retire.json')),
    today,
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

export async function retireRoute(req, res, route, opts = {}) {
  if (route !== '/api/skills/retire') return false;
  if (req.method !== 'GET') { json(res, 405, { error: 'GET only' }); return true; }
  json(res, 200, retirePayload(opts));
  return true;
}
