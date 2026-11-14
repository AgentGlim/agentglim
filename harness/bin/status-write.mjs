#!/usr/bin/env node
// status-write.mjs: writes _agentglim/data/status.json, the Observatory "Status" card (owner 2026-11-01).
// The watcher runs it on every status check with its own words:
//   node _run/bin/status-write.mjs --done "..." --running "..." --blocked "..." --next "..." [--optimize "..."]
// --optimize: one line on how to cut time or tokens or raise quality right now (owner 2026-11-01); shown on the card's optimize block
// The hourly timer (obs-status.timer) runs it with --hourly: numbers refresh and the last written words stay;
// it skips while overnight mode (config.json claudeMax window) is on.
// Packaged in agentglim/harness/bin; the harness keeps a link at <run>/bin/status-write.mjs. Paths and the optional
// parts (Claude usage script, one plan's sub-items and feature loop) come from harness config "status" (app/settings.defaults.json).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { harnessConfig } from '../config.mjs';
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`usage: node status-write.mjs --done "..." --running "..." --blocked "..." --next "..." [--optimize "..."]
       node status-write.mjs --hourly | --auto
Writes the dashboard's Status card (<data>/status.json) and marks pending Refresh requests answered.
The dashboard URL: AGENTGLIM_URL, the running server's <data>/server-url.json,
else harness config status.appUrl (default http://127.0.0.1:18990).`);
  process.exit(0);
}
const H = harnessConfig(), S = H.status || {};
const PLANS = H.roots.plans, RUN = H.run, OUT = path.join(H.roots.data, 'status.json');
// An old headed session must not answer requests belonging to the new watcher.
if (process.env.CODEX_THREAD_ID) {
  let target; try { target = JSON.parse(fs.readFileSync(`${RUN}/flags/watcher-target.json`, 'utf8')).thread; } catch {}
  if (target && target !== process.env.CODEX_THREAD_ID) {
    console.error('Watcher ownership transferred; this session cannot write Status.'); process.exit(1);
  }
}
const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) { const k = args[i].slice(2); opt[k] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; }
const now = new Date();
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const md = readJson(H.files.modes, {}); // overnight = modes.json harness (owner 2026-11-01)
const cm = md.harness === 'overnight' ? { from: null, until: md.harnessUntil || '2999-01-01' } : null;
const overnight = !!(cm && (!cm.from || new Date(cm.from) <= now) && (!cm.until || now < new Date(cm.until)));
if (opt.hourly && overnight) { console.log('overnight mode: hourly status skipped'); process.exit(0); }
const prev = readJson(OUT, {});
let usage = null;
if (S.usageGate) try { const g = execFileSync('bash', [S.usageGate], { encoding: 'utf8', timeout: 60000 }).trim(); const m = g.match(/(\d+)/); usage = { text: g, pct: m ? +m[1] : null }; } catch (e) { const m = String(e.stdout || '').match(/(\d+)/); usage = { text: String(e.stdout || 'unknown').trim(), pct: m ? +m[1] : null }; }
let snap = null;
const liveUrl = (() => { const j = readJson(path.join(H.roots.data, 'server-url.json'), {}); try { if (j.url && j.pid) { process.kill(j.pid, 0); return j.url; } } catch (e) { if (e.code === 'EPERM') return j.url; } return null; })(); // the running server's own port
const APP_URL = String(process.env.AGENTGLIM_URL || liveUrl || S.appUrl || 'http://127.0.0.1:18990').replace(/\/$/, '');
try { snap = JSON.parse(execFileSync('curl', ['-s', '-m', '20', `${APP_URL}/api/snapshot`], { encoding: 'utf8', maxBuffer: 1 << 28 })); } catch {}
if (!snap) console.error(`status-write: warning: the dashboard did not answer at ${APP_URL}/api/snapshot, so plan counts are empty. Start it, or set AGENTGLIM_URL to its address (e.g. http://127.0.0.1:<port>).`);
const projects = (snap?.projects || []).map((p) => ({ dir: p.dir, pct: p.progress?.pct ?? null, state: p.active ? 'running' : (p.endState || (p.approved ? 'owner-verified' : (p.autoComplete || p.stage === 'done') ? 'auto-complete' : null)) || (p.held ? 'held' : 'waiting') }));
// end states (owner 2026-11-10, HARNESS 1.5): owner-verified (owner signed off) and auto-complete (agents finished, no sign-off); no "done"
const counts = { running: 0, held: 0, waiting: 0, 'auto-complete': 0, 'owner-verified': 0 };
for (const p of projects) counts[p.state]++;
let wl = ""; try { if (S.watchList) wl = fs.readFileSync(S.watchList, "utf8"); } catch {}
const watch = new Set(wl.split(/\s+/).filter(Boolean));
const plans = projects.filter((p) => p.state === 'running' || watch.has(p.dir)).sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
const sub = S.featurePlan ? readJson(`${PLANS}/${S.featurePlan}/_build/subitems.json`, { items: [] }).items.filter((i) => +i.id >= (S.featureMinId ?? 10)).map((i) => ({ id: i.id, title: i.title, status: i.status, pct: i.pct })) : [];
let loop = '';
try { if (S.featurePlan && S.featureLoop) loop = execFileSync('bash', [S.featureLoop, 'status', S.featurePlan], { encoding: 'utf8', timeout: 20000 }).split('\n')[0]; } catch {}
const asked = ['done', 'running', 'blocked', 'next', 'optimize'].some((k) => typeof opt[k] === 'string');
const lines = asked ? { done: opt.done || '', running: opt.running || '', blocked: opt.blocked || '', next: opt.next || '', optimize: opt.optimize || '' } : prev.lines || {};
const hist = (prev.history || []).concat([{ at: now.toISOString(), usage: usage?.pct ?? null, running: counts.running }]).slice(-48);
const out = { at: now.toISOString(), source: asked ? 'asked' : 'hourly', linesAt: asked ? now.toISOString() : prev.linesAt || null, mode: overnight ? 'overnight' : 'normal', driverAlive: snap?.driverAlive ?? null, usage, counts, plans, features: sub, loop, lines, history: hist };
fs.writeFileSync(`${OUT}.next`, JSON.stringify(out, null, 2) + '\n');
fs.renameSync(`${OUT}.next`, OUT);
// --auto (owner 2026-11-11): status-refresh.sh / the AgentGlim 5-min fallback answer pending asks with the numbers, marked "auto"
if (asked || opt.auto) { const AD = H.files.statusAsk; try { for (const f of fs.readdirSync(AD).filter((x) => /^\d+\.json$/.test(x))) { const j = readJson(`${AD}/${f}`, {}); fs.writeFileSync(`${AD}/${f}.answered`, JSON.stringify({ ...j, answeredAt: asked ? out.linesAt : now.toISOString(), answeredBy: asked ? 'superagent' : 'auto' }) + '\n'); fs.unlinkSync(`${AD}/${f}`); } } catch {} } // answers the Status card's "refresh now" asks (owner 2026-11-01)
console.log(`status written (${out.source}, ${out.mode}): ${OUT}`);
