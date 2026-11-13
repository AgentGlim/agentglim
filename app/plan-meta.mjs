// plan-meta.mjs: what the board knows about plan folders without the driver's state.json.
//   planDirs(root)      every NN-slug plan folder that has a PLAN.md (a new plan shows up as soon as its folder exists)
//   planTitle(root,dir) "# Plan 70: Leads" -> "Leads"
//   foldNotes(root)     merges, from the one place they are written: a "Folded into NN" note at the top of the child's
//                       PLAN.md, e.g. `> **Folded into 12-demo-app** (2026-11-11): see plan 12, phase 4.` ("Merged into"
//                       works too; "NN" alone names the plan folder that starts with NN-). -> {child: {parent, date, note}}
//   planIconsFor(root,file)  an icon for every plan folder (plan-icons.js), auto picks saved in `file`
//   planCategory(dir, cats, folds)  categories.json, else the category most of its folded plans have, else by keywords
import fs from 'node:fs';
import path from 'node:path';
import './plan-icons.js';

const PLAN_DIR = /^\d\d-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FOLD = /\b(?:folded|merged)\s+into\s+\**\s*(?:plan\s+)?(\d\d)(-[a-z0-9]+(?:-[a-z0-9]+)*)?/i;
const head = (file, n = 4096) => { try { const fd = fs.openSync(file, 'r'); try { const b = Buffer.alloc(n); const k = fs.readSync(fd, b, 0, n, 0); return b.toString('utf8', 0, k); } finally { fs.closeSync(fd); } } catch { return ''; } };

let dirCache = { root: null, at: 0, list: [] };
export function planDirs(root, now = Date.now()) {
  if (dirCache.root === root && now - dirCache.at < 30e3) return dirCache.list;
  let list = [];
  try { list = fs.readdirSync(root).filter((d) => PLAN_DIR.test(d) && fs.existsSync(path.join(root, d, 'PLAN.md'))).sort(); } catch {}
  dirCache = { root, at: now, list };
  return list;
}

export function planTitle(root, dir) {
  const m = head(path.join(root, dir, 'PLAN.md'), 1024).match(/^#\s+(?:Plan\s+\d+\s*[:.-]\s*)?(.+)$/m);
  return m ? m[1].replace(/\s*\(`[^`]*`\)\s*$/, '').replace(/[*_`]/g, '').trim().slice(0, 80) : dir.slice(3).replace(/-/g, ' ');
}

// only the top of PLAN.md counts (the first 25 lines), so a plan that merely mentions a fold further down is not folded
export function foldNote(text) {
  const top = String(text || '').split('\n').slice(0, 25);
  for (const line of top) {
    const m = line.match(FOLD);
    if (m && /^\s*(?:>|\*\*|_)/.test(line)) return { num: m[1], slug: m[2] ? m[1] + m[2] : null, date: (line.match(/\b(20\d\d-\d\d-\d\d)\b/) || [])[1] || null,
      note: line.replace(/^\s*>\s*/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim().slice(0, 400) };
  }
  return null;
}

let foldCache = { root: null, at: 0, map: {} };
export function foldNotes(root, now = Date.now()) {
  if (foldCache.root === root && now - foldCache.at < 30e3) return foldCache.map;
  const dirs = planDirs(root, now), map = {};
  for (const d of dirs) {
    const f = foldNote(head(path.join(root, d, 'PLAN.md')));
    if (!f) continue;
    const parent = f.slug && dirs.includes(f.slug) ? f.slug : dirs.find((x) => x.startsWith(`${f.num}-`) && x !== d);
    if (parent && parent !== d) map[d] = { parent, date: f.date, note: f.note };
  }
  foldCache = { root, at: now, map };
  return map;
}

// fold-note merges as sub-project entries (subprojects.mjs adds them under the parent next to the hand-kept list)
export function foldEntries(root, now = Date.now()) {
  const out = {};
  for (const [child, f] of Object.entries(foldNotes(root, now))) {
    (out[f.parent] ||= []).push({ plan: child, fold: true, name: planTitle(root, child), full: f.note, merged: f.date || 'see fold note', ver: 'fold note',
      where: `plans/${child}`, code: '', items: [], src: `${child}/PLAN.md (fold note at the top)` });
  }
  return out;
}

const CAT_WORDS = { Business: /lead|prospect|client|dashboard|product|sales|proposal|pilot|portal|report|insight|shop|pricing|revenue|crm|audit/,
  Content: /video|youtube|motion|thumbnail|brand|content|voice|image|render|blender|3d|music|channel/,
  Agents: /agent|model|harness|router|eval|bench|memory|ai|llm|sandbox/, Gaming: /game|pixel|rpg|souls|crawler|godot|bevy/ };
export function planCategory(dir, cats = {}, folds = {}, title = '') {
  const nn = dir.slice(0, 2);
  if (cats.plans?.[nn]) return cats.plans[nn];
  const kids = Object.entries(folds).filter(([, f]) => f.parent === dir).map(([c]) => cats.plans?.[c.slice(0, 2)]).filter(Boolean);
  if (kids.length) { const n = {}; for (const k of kids) n[k] = (n[k] || 0) + 1; return Object.entries(n).sort((a, b) => b[1] - a[1])[0][0]; }
  const w = `${dir} ${title}`.toLowerCase();
  return Object.entries(CAT_WORDS).find(([, re]) => re.test(w))?.[0] || 'Ops';
}

let iconCache = { key: '', icons: {} };
export function planIconsFor(root, file, now = Date.now()) {
  const dirs = planDirs(root, now), key = dirs.join(',');
  if (iconCache.key === key && iconCache.file === file) return iconCache.icons;
  let saved = {}; try { saved = JSON.parse(fs.readFileSync(file, 'utf8')).picks || {}; } catch {}
  const r = globalThis.PlanIcons.pick(dirs.map((dir) => ({ dir, title: planTitle(root, dir) })), saved);
  if (JSON.stringify(r.saved) !== JSON.stringify(saved) && file) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify({ about: 'Auto-picked plan icons (plan-icons.js POOL keys). A plan keeps its pick; delete a line to re-pick.', picks: r.saved }, null, 1)); fs.renameSync(`${file}.tmp`, file); } catch {}
  }
  iconCache = { key, file, icons: Object.fromEntries(Object.entries(r.icons).map(([d, x]) => [d, x.path])) };
  return iconCache.icons;
}
