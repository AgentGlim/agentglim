// GET /api/remote/phone-snapshot: the reduced snapshot for the phone Dashboard (sub-item 03 A1). Only the fields the
// six phone cards use (Status, Active builds, Pipeline, Approvals, Active agents, Providers) plus the model-icon picks.
// The full /api/snapshot is ~220 KB; this stays well under 60 KB (tests pin the field list and the size).
// Text fields are trimmed; the phone renders all of them with textContent.
import { sectionOf } from '../../sections.mjs'; // one plan, one section: Active builds > Pipeline (owner 2026-11-13)
export const PHONE_FIELDS = Object.freeze(['at', 'driverAlive', 'status', 'builds', 'pipeline', 'approvals', 'agents', 'providers', 'iconStore']);
export const FIELD_KEYS = Object.freeze({
  status: ['line', 'tally', 'flags', 'at'],
  builds: ['dir', 'stage', 'note', 'gateAt', 'pct', 'round', 'sub', 'models'],
  pipeline: ['dir', 'stage', 'stageIndex', 'pct', 'held', 'active', 'cat'],
  approvals: ['project', 'open', 'page'],
  agents: ['project', 'role', 'task', 'step', 'model', 'provider', 'started'],
  providers: ['id', 'name', 'provider', 'windows', 'error'],
});
const T = (v, n = 160) => (v == null ? null : String(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

export function phoneSnapshot(snap, { now = Date.now(), approvals = null } = {}) {
  const s = snap && typeof snap === 'object' ? snap : {};
  const projects = Array.isArray(s.projects) ? s.projects : [];
  const dg = s.statusDigest || {};
  const status = {
    line: T(dg.line || (s.driverAlive === false ? 'Driver off. Nothing moves until it restarts' : ''), 200),
    tally: dg.tally && typeof dg.tally === 'object' ? Object.fromEntries(Object.entries(dg.tally).filter(([, v]) => Number.isFinite(v)).slice(0, 12)) : null,
    flags: (Array.isArray(dg.flags) ? dg.flags : []).slice(0, 8).map((f) => ({ level: f.level === 'critical' ? 'critical' : 'warn', where: T(f.where, 40), dir: T(f.dir, 64), text: T(f.text, 200) })),
    at: num(dg.at),
  };
  // one plan, one section (owner 2026-11-13): the same rule the desktop tables use (app/sections.mjs), so a plan
  // is in exactly one of the two phone cards
  const section = (p) => (p.section === 'active' || p.section === 'pipeline' ? p.section : sectionOf(p));
  const builds = projects.filter((p) => section(p) === 'active').slice(0, 12).map((p) => ({
    dir: T(p.dir, 64), stage: T(p.stage, 40), note: T(p.activeBuild?.note, 160), gateAt: num(p.activeBuild?.gateAt), pct: num(p.progress?.pct), round: T(p.progress?.round, 20),
    sub: Array.isArray(p.sub) ? p.sub.slice(0, 10).map((x) => ({ id: T(x.id, 12), title: T(x.title, 80), status: T(x.status, 20), pct: num(x.pct), agent: x.agent ? { step: T(x.agent.step, 20), round: num(x.agent.round), model: T(x.agent.model, 40) } : null })) : null,
    models: (Array.isArray(p.working) ? p.working : []).slice(0, 6).map((w) => ({ role: T(w.role, 30), model: T(w.model, 60), provider: T(w.provider, 30), paused: !!w.paused })),
  }));
  const pipeline = projects.filter((p) => section(p) === 'pipeline').slice(0, 80).map((p) => ({ dir: T(p.dir, 64), stage: T(p.stage, 40), stageIndex: num(p.stageIndex), pct: num(p.progress?.pct), held: !!p.held, active: num(p.active) || 0, cat: T(p.cat?.name ?? p.cat, 30) }));
  let ap = Array.isArray(s.approvalCounts) ? s.approvalCounts : [];
  if (!ap.length && approvals?.items) { const m = new Map(); for (const i of approvals.items) if (!i.done) m.set(i.project || 'other', (m.get(i.project || 'other') || 0) + 1); ap = [...m].map(([project, open]) => ({ project, open })); }
  const appr = ap.slice(0, 60).map((c) => ({ project: T(c.project, 64), open: num(c.openOwner ?? c.open) || 0, page: T(c.apPage ?? c.page, 200) })).filter((c) => c.open > 0);
  const agents = (Array.isArray(s.agents) ? s.agents : []).filter((a) => a.active).slice(0, 30).map((a) => ({ project: T(a.project, 64), role: T(a.role, 30), task: T(a.task, 80), step: T(a.step, 20), model: T(a.model, 60), provider: T(a.provider, 30), started: num(a.started) }));
  const lim = Array.isArray(dg.limits) && dg.limits.length ? dg.limits : Array.isArray(s.limits) ? s.limits : [];
  const providers = lim.slice(0, 12).map((l) => ({ id: T(l.id, 40), name: T(l.name, 60), provider: T(l.provider, 30),
    windows: (Array.isArray(l.windows) ? l.windows : []).filter((w) => ['5h', '7d'].includes(w.label)).slice(0, 2).map((w) => ({ label: T(w.label, 8), pct: num(w.pct), resetsAt: w.resetsAt ?? null })), error: T(l.error, 120) }));
  const ic = s.modelIcons && typeof s.modelIcons === 'object' ? { picks: s.modelIcons.picks || {}, auto: s.modelIcons.auto || {} } : null;
  return { at: now, driverAlive: s.driverAlive !== false, status, builds, pipeline, approvals: appr, agents, providers, iconStore: ic };
}
