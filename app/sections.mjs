// One plan, one section (owner rule 2026-11-13). The dashboard tables (index.html) and the phone card read the
// snapshot's `section` field, which server.mjs fills with sectionOf(), so every view agrees: a plan is never
// listed in two sections at the same time.
//
// Precedence: Active builds > Pipeline.
//   active    a live build round: an ACTIVE marker at a gate (activeBuild), or a driver stage / live job without
//             the marker (liveBuild); a product row the driver has not run yet (noState, its folded plans are
//             nested under it); and the AgentGlim build project itself, which always has the AgentGlim row.
//   pipeline  everything else, including held and done plans: "on hold" is a badge on the Pipeline row and
//             "done" is the last stage column (the Status "finished in the last N days" strip is history,
//             not a section, and the Status overview list is an index of every plan, not a plan table).
// A plan other plans are folded into keeps ONE row: while the driver has not run it, it is a product row in
// Active builds; once it has driver state (running, on hold, done) its own stage-column row is the Pipeline row.
export const AGENTGLIM_PLAN = '68-observatory-app';
export const SECTIONS = Object.freeze(['active', 'pipeline']);

// A project (the snapshot's shape: dir, activeBuild, liveBuild, foldedInto, merged, noState) -> its section.
export function sectionOf(p) {
  if (!p || typeof p !== 'object') return 'pipeline';
  if (String(p.dir || '') === AGENTGLIM_PLAN) return 'active'; // the AgentGlim row lives in Active builds
  if (p.activeBuild || p.liveBuild) return 'active'; // a live build round
  // product row: a plan other plans are folded into, or a plan the driver has not run yet
  const product = !p.foldedInto && ((Array.isArray(p.merged) && p.merged.length > 0) || !!p.noState);
  if (product && p.noState) return 'active'; // plan written, waiting for the owner; the driver never ran it
  return 'pipeline';
}

// The projects split into the two plan sections in one pass. Views that list plans use this (or p.section)
// instead of their own conditions, so they cannot drift apart.
export function bySection(projects) {
  const out = { active: [], pipeline: [] };
  for (const p of projects || []) {
    const s = p.section === 'active' || p.section === 'pipeline' ? p.section : sectionOf(p);
    out[s].push(p);
  }
  return out;
}

// dirs that the given row lists have in common; empty unless a plan is listed in two of them (a bug)
export const overlapDirs = (...lists) => {
  const out = new Set();
  for (let i = 0; i < lists.length; i++) for (let j = i + 1; j < lists.length; j++) {
    const a = new Set((lists[i] || []).map((p) => p.dir)), b = new Set((lists[j] || []).map((p) => p.dir));
    for (const d of a) if (b.has(d)) out.add(d);
  }
  return [...out];
};
