// Sub-item tidy job: marks finished sub-items of the Active builds table as archived in
// <data>/subitems-archived.json; the dashboard reads that file (snapshot field subArchived) and folds archived
// items away behind a "N done, hidden (show)" link. Pure code: no AI call, no network, nothing is deleted.
//   key      "<row dir>:<item id>"  (plan sub-items use the plan folder, AgentGlim's features use "observatory")
//   finished the item's own status is done, or (linked item) its plan is finished or owner-approved
//   archived entries stay in the file forever; an item that is no longer finished gets state "reopened"
// Idempotent: a run on unchanged data rewrites nothing. One log line per run.
import fs from 'node:fs';
import { DATA } from './paths.mjs';

export const ARCHIVE_FILE = `${DATA}/subitems-archived.json`;
const ABOUT = 'Finished Active builds sub-items, written by app/subitems-archive.mjs every 30 min (no AI). state archived = finished and folded away in the dashboard; reopened = it moved again. Entries are never removed.';

let cache = { mtime: 0, size: 0, d: null };
export function readArchive(file = ARCHIVE_FILE) {
  try {
    const st = fs.statSync(file);
    if (cache.d && cache.mtime === st.mtimeMs && cache.size === st.size && cache.file === file) return cache.d;
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = { mtime: st.mtimeMs, size: st.size, d: d && typeof d.items === 'object' ? d : { items: {} }, file };
    return cache.d;
  } catch { return { items: {} }; }
}
// what the snapshot carries: key -> archivedAt (ISO) for state archived
export function archivedMap(file = ARCHIVE_FILE) {
  const out = {};
  for (const [k, v] of Object.entries(readArchive(file).items || {})) if (v.state === 'archived') out[k] = v.archivedAt;
  return out;
}

// same rule as the dashboard's sub-row: a linked item takes its plan's live state, otherwise its own status
export function isFinished(it, plans) {
  const q = it.plan ? plans.find((x) => x.dir === it.plan || x.dir.startsWith(`${it.plan}-`)) : null;
  return q ? q.stage === 'done' || !!q.approved : it.status === 'done';
}
// groups: [{ key, items: [{id, title, status, plan}] }]; plans: the snapshot's projects
export function archiveRun({ groups, plans, file = ARCHIVE_FILE, now = new Date() }) {
  const cur = readArchive(file), items = { ...(cur.items || {}) };
  let seen = 0, finished = 0, added = 0, reopened = 0, kept = 0, changed = false;
  for (const g of groups) for (const it of g.items || []) {
    seen++;
    const key = `${g.key}:${it.id}`, e = items[key], fin = isFinished(it, plans);
    if (fin) {
      finished++;
      if (e?.state === 'archived') { kept++; continue; }
      items[key] = { title: String(it.title || '').slice(0, 120), state: 'archived', archivedAt: now.toISOString(), ...(e?.reopenedAt ? { reopenedAt: e.reopenedAt } : {}) };
      added++; changed = true;
    } else if (e?.state === 'archived') {
      items[key] = { ...e, state: 'reopened', reopenedAt: now.toISOString() };
      reopened++; changed = true;
    }
  }
  if (changed) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ about: ABOUT, updated: now.toISOString(), items }, null, 1) + '\n');
    fs.renameSync(tmp, file); // atomic replace of the old file; nothing is removed
  }
  const line = `[subitems-archive] ${now.toISOString()} checked ${seen}, finished ${finished}, newly archived ${added}, reopened ${reopened}, already archived ${kept}${changed ? '' : ' (file unchanged)'}`;
  console.log(line);
  return { seen, finished, added, reopened, kept, changed, line };
}

// the sub-item groups of a snapshot (server base): each plan's _build/subitems.json rows plus AgentGlim's features
export function groupsOf(base) {
  const gs = (base.projects || []).filter((p) => p.sub?.length).map((p) => ({ key: p.dir, items: p.sub }));
  if (base.obsRow?.sub?.length) gs.push({ key: 'observatory', items: base.obsRow.sub });
  return gs;
}
