// Run AgentGlim: near-realtime tracker for the plans build run.
//   node server.mjs [port]   (default 18990, binds 127.0.0.1; open http://localhost:18990)
// Reads, never writes, the run's files:
//   plans/_run/state.json, driver.log, flags/   driver state, events, limits
//   plans/NN-*/_build/**/meta, rc, pid          every agent job (plan builder,
//                                               orchestrator, worker, auditor...)
//   **/session/*.jsonl                          Pi messages: tokens, cost, model
//   **/events.jsonl                             Codex turns: tokens
//   ~/.local/share/opencode/opencode.db         OpenCode Zen free-model messages
//   imported/wsl/**                             the same sources copied from an older machine's disk (optional import)
// and shows each subscription's live plan limits from plans/_run/budget.json (the driver is the only
// poller since 2026-10-20: _run/bin/limits.mjs; the budget router adds step, pace and order).
// Writes only its own data/: history.ndjson, run-models.json (ledger keys of the models the run uses, for price-check.mjs),
// classes.json (approved model classifications, POST /api/classes),
// model-icons.json (per-model icon picks, POST /api/model-icons, plus the rule's auto icons for new tiers; see model-icons.js)
// and jev-cache.json (Jev's guesses for kinds/models the name rules in classify.mjs can't place).
// Approving a price proposal (POST /api/prices) writes the configured price ledger through its own
// tools/update_prices.py --set; price-check.mjs (cron, every 7 days) does the rest of the price upkeep.
// Serves the dashboard at /, a JSON snapshot at /api/snapshot and a server-sent
// event stream at /api/stream (one snapshot every 5 s). Appends a one-line summary
// per minute to data/history.ndjson so charts survive restarts.
import './undici-guard.mjs'; // before everything: logs and survives undici's assert(!this.paused) fetch race (2026-11-06)
import './env.mjs'; // first: API keys and settings from <repo>/.env (process env wins; ~/.bashrc fallback is deprecated)
import { ENV_FILE, keyStatuses } from './env.mjs'; // Setup page shows where keys go
import fs from 'node:fs';
import os from 'node:os';
import { listProcesses, readMemoryInfo } from './proc.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import { liveStatus } from './refresh-status.mjs';
import { roleModelsView } from './roles.mjs';
import { routingView, saveFeedback } from './routing.mjs'; // Jev routing dashboard
import { ensureDefaultGoals, syncGoals } from './goals-sync.mjs'; // Goals section in Status
// Dev copy (repo split): AGENTGLIM_DEV=1 turns off everything that writes into the shared harness or
// spends money: the write routes in DEV_BLOCKED, the Claude usage refresh, the approvals page rebuild, the Jev priority
// run and the Control remote listener and push. AGENTGLIM_DEV_WRITES=1 turns the write routes back on for a test.
// Production hides dev-only blocks: any <details class="... dev-only">...</details> in index.html
const stripDevOnly = (h) => h.replace(/<details class="[^"]*\bdev-only\b[^"]*">[\s\S]*?<\/details>/g, '');
const DEV = process.env.AGENTGLIM_DEV === '1', DEV_WRITES = DEV && process.env.AGENTGLIM_DEV_WRITES === '1';
const DEV_BLOCKED = new Set(['/api/local-model', '/api/agy-override', '/api/speed', '/api/hold', '/api/category-hold', '/api/priority', '/api/mode', '/api/status-refresh', '/api/status-ask',
  '/api/owner-claim', '/api/review-reject', '/api/classes', '/api/prices', '/api/harness-setting', '/api/role-models', '/api/goals/weekly-review']);
const devBlocked = (route, method) => DEV && !DEV_WRITES && !['GET', 'HEAD', 'OPTIONS'].includes(method)
  && (DEV_BLOCKED.has(route) || route === '/control' || route.startsWith('/control/') || route.startsWith('/api/control/'));
const GOALS_CTX = `${DATA}/goals-context.json`;
try { ensureDefaultGoals(); syncGoals(); } catch (e) { console.error('goals sync failed', e.message); }
try { startGoalsJobs({ dev: DEV }); } catch (e) { console.error('goals jobs failed to start', e.message); }
import { execFile, spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { normalizeOpenUrl, sameAppRequest } from './open-url-rules.mjs';
import { makeHostGuard, envExtraHosts, fileExtraHosts } from './host-guard.mjs';
import { projectIcons, hostAliases } from './user-config.mjs';
import './model-icons.js'; // sets globalThis.ModelIcons (shared with the dashboard and /model-icons)
import { ELEVEN_USAGE, subscription as elevenSub, rates as elevenRates } from './elevenlabs.mjs'; // ElevenLabs card + ledger
import { FINISHED_MAX_DAYS, lastDoneAt, finishedWithin } from './finished.mjs';
import { sectionOf } from './sections.mjs'; // one plan, one section: Active builds > Pipeline (owner 2026-11-13)
import { classify, keyOf, kindOf, ruleClass, askJev, approve, loadApproved, agentKinds, priceOf, AGENT_SH, WORKER_SH, PROVIDERS, CLASSES, JEV_USAGE } from './classify.mjs';
// live limits and the router's budget, written by the driver (one poller; Claude's endpoint 429s fast)
const BUDGET_FILE = `${RUN_DIR}/budget.json`;
function budget() {
  try {
    if (!driverActive()) return { limits:usagePoller.view(), mode:null, order:null, at:Date.now() };
    const b = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    const stale = Date.now() - b.at > 5 * 60e3;
    const pos = (id) => { const i = (b.order?.worker || []).indexOf(id); return i < 0 ? null : i; };
    const codexPlan = (b.limits || []).find((l) => l.id === 'codex')?.plan;

    let claudeCache; try { claudeCache = JSON.parse(fs.readFileSync(`${RUN}/flags/claude-usage.json`, 'utf8')); } catch {}
    const displayLimits = (b.limits || []).map((l) => {
      if (l.id === 'codex' && l.plan === 'prolite') return { ...l, plan: '$100/mo', noFiveHour: true,
        windows: [{ label: '5h', pct: null, resetsAt: null, notApplicable: true },
          { ...(l.windows.find((w) => w.label === '7d' && w.pct != null) || l.windows.find((w) => w.pct != null) || {}), label: '7d' }] };
      if (l.id === 'codex' && l.plan === 'plus') return { ...l, plan: '$20/mo' };
      if (l.id === 'claude' && !l.windows.some((w) => w.pct != null) && claudeCache?.windows?.length) return {
        ...l, windows: claudeCache.windows, at: claudeCache.at, cachedUsage: Date.now() - claudeCache.at > 15 * 60e3, usageCheck, usageSource: claudeCache.source || 'driver',
        error: Date.now() - claudeCache.at > 15 * 60e3 ? `${l.error || 'Live usage unavailable'}; last known usage, not a fresh reading${usageCheck.at ? ` · fresh check ${new Date(usageCheck.at).toLocaleTimeString('en-GB')} failed: ${usageCheck.error}` : ''}` : null };
      return l;
    });
    return { limits: displayLimits.map((l) => ({ ...l, budget: b.providers?.[l.id] ? { ...b.providers[l.id], order: pos(l.id) } : null,
      error: l.error || (stale ? `budget.json ${Math.round((Date.now() - b.at) / 60e3)} min old (driver stopped?)` : null) })),
      mode: b.mode, order: b.order, at: b.at };
  } catch { return { limits: usagePoller.view(), mode: null, order: null, at: null }; }
}
let usageCheck = {};
const refreshClaudeUsage = () => usagePoller.tick().then(() => (usageCheck = {at:Date.now(),ok:true,source:'subscription poller'}));
// routing panel: per-provider step/pace/slots, the order per role, and the shadow log (driver.log
// "budget: would X; actual Y" lines since config.shadowSince) with agree/disagree counts
const ROUTER_CFG = `${RUN_DIR}/config.json`;
function routing() {
  let cfg = {}, b = {};
  try { cfg = JSON.parse(fs.readFileSync(ROUTER_CFG, 'utf8')); } catch {}
  try { b = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8')); } catch {}
  const since = cfg.shadowSince ? Date.parse(cfg.shadowSince) : 0;
  const lines = [];
  for (const l of readText(`${RUN}/driver.log`).split('\n')) {
    const m = l.match(/^(\S+ \S+) budget: would (.*); actual (.*)$/); if (!m) continue;
    const t = Date.parse(m[1].replace(' ', 'T')); if (since && t < since) continue;
    const w = m[2], actual = m[3].trim().split(/\s/)[0];
    const pick = w.match(/^pick (\S+)/), route = w.match(/^route .*? to (\S+)/);
    const would = pick ? pick[1] : route ? route[1] : w.split(/\s/)[0];
    const what = pick ? w.replace(/^pick \S+ for /, '').replace(/ \(.*$/, '') : w.replace(/^\S+ /, '').replace(/ \(.*$/, '');
    const why = (w.match(/\((.*)\)$/) || [])[1] || '';
    lines.push({ t, what, would, actual, why, agree: would === '?' ? null : would === actual });
  }
  const n = (v) => lines.filter((x) => x.agree === v).length;
  let localPilot = null;
  try { localPilot = JSON.parse(fs.readFileSync(`${RUN}/flags/qwen-pilot-state.json`, 'utf8')); } catch {}
  const pilotReady = localPilot?.ready && Date.now() / 1000 - localPilot.at < 20
    && localPilot.ram_free_mib >= 6144 && localPilot.gpu_free_mib >= 512
    && fs.existsSync(`${RUN}/flags/qwen-pilot-enabled`)
    && !['qwen-pilot-paused', 'mem_high', 'mem_watch'].some((f) => fs.existsSync(`${RUN}/flags/${f}`));
  let localActive = 0; try { localActive = activeLocalAgents(); } catch {}
  const onDemand = fs.existsSync(`${RUN}/flags/qwen-pilot-ondemand`);
  return { localActive, localState: !fs.existsSync(`${RUN}/flags/qwen-pilot-enabled`) ? 'off' : fs.existsSync(`${RUN}/flags/qwen-pilot-paused`) ? 'paused' : pilotReady ? 'ready' : onDemand ? 'on-demand' : 'not ready', localOff: !pilotReady, localPilot: localPilot ? { ready: !!pilotReady, model: localPilot.model, context: localPilot.context_per_worker, gpuLayers: localPilot.gpu_layers } : null, mode: b.mode || cfg.mode || null, shadowSince: since || null, shadowHours: 24, at: b.at || null,
    resetsCheck: (() => { try { const r = JSON.parse(fs.readFileSync(`${RUN}/reset-credits.json`, 'utf8')); return { checkedAt: r.checkedAt || r.at || null, claude: r.claude || null, changed: fs.existsSync(`${RUN}/flags/resets-changed.json`) }; } catch { return null; } })(),
    order: b.order || null, providers: b.providers || {}, agree: n(true), disagree: n(false), unknown: n(null),
    recent: lines.slice(-14).reverse() };
}
import { setPriceAsync, loadProposals, dropProposal, loadState, LEDGER, EVERY_DAYS } from './price-check.mjs';
import { approvals, markDone, setChoice, servePages, priorities } from './approvals.mjs';
import { auditEstimate } from './audit-estimate.mjs';
import { rankBlockers, optimizeTips, claim, unclaim, claimsMtime, enrichFlags, healthDeep, watcherDeep } from './blockers.mjs'; // ranked owner blockers, optimize tips, done-claims checked by the watcher
import { makeOthers } from './others.mjs'; // "Other projects" table: ~/dev/projects/* except plans (2026-10-21)
import { watcherRow } from './superagent.mjs'; // Agentglim SuperAgent row: the plans SuperAgent session and its live helper agents
import { sendToAgent, sendStatus, sendConfig } from './send-to-agent.mjs'; // Approvals "Send to agent" adapters
import { inboxResendStatus, startInboxResend } from './inbox-resend.mjs'; // unanswered chat messages: wake nudges, .resent marks, status line
import { archiveRun, archivedMap, groupsOf } from './subitems-archive.mjs'; // finished sub-items -> data/subitems-archived.json every 30 min, pure code
import { subProjects } from './subprojects.mjs'; // whole plans merged into another project (51-54 into 03, 55 into 68), drawn as cards under the parent row
import { makeTrials } from './trials.mjs'; // Trials block on the Status card
import { fleetRoute, readFleet } from './fleet.mjs'; // Containers card: reads the fleet snapshot only (v3)

import { repoPlans, readFeatures, saveFeatures, readTracked, visibleJobs, groupJobs, jobReport, makeReaper, liveJobs, goodProject, UNASSIGNED, shownStatus, claudeKindId } from './jobs.mjs';
import { planDirs, planTitle, foldNotes, planCategory, planIconsFor } from './plan-meta.mjs'; // plan folders, fold-note merges, auto icons  // tracked jobs: every SuperAgent hand-off
import { usagePoller, procGuard, portableRoute, startPortable, portableState, driverActive } from './portable.mjs';
import { watchersView } from './heartbeats.mjs'; // SuperAgent heartbeats: private data plus plans-harness beats, read fresh per view
import { subagentStatus } from './subagent-status.mjs';
import { subscriptionTotals } from './price-data.mjs';
import { liveStatus as displayLiveStatus } from './live-status.mjs';
import { localStatus, localSwitch } from './local.mjs'; // Local status section
import { has, emptyModes, emptyAgyBench } from './empty-fallbacks.mjs'; // 200 + empty shape when the harness is absent
import { integrations, integrationView, integrationPage } from './integrations.mjs';
import { skillEditorRoute } from './skill-editor.mjs'; // bundled Skill Editor under /skills and /api/skills/*
import { skillGroupsRoute, runGrouping } from './skill-groups.mjs'; // skill auto-grouping: daily job + Accept/Reject chips under /api/skills/groups
import { register as registerScheduledJob } from './scheduler.mjs'; // STUB until Plan 1 lands the shared scheduler
import { retireRoute } from './skills-retire.mjs'; // Skills to retire page under /skills/retire and /api/skills/retire
import { prefsRoute } from './prefs.mjs';
import { errorShape, getOverview, queueWeeklyReview, runRefresh, weeklyStatus } from './goals-report.mjs'; // Goals sub-app data (plan 1)
import { goalsJobsStatus, startGoalsJobs } from './goals-jobs.mjs'; // shared scheduler jobs (scheduler.mjs)
import { watcherState } from './watchers.mjs'; // SuperAgent watcher state for the header dot (harness scripts or one heartbeat)
import { watcherSnapshot } from './heartbeats.mjs'; // one reader for every SuperAgent heartbeat, read at view time
import { currentVersion, checkForUpdate, updateCheckEnabled, versionStatus } from './update-check.mjs'; // newer-release notice
import { makeBuildId } from './build-id.mjs'; // page build id: the dashboard reloads itself when the page code changes
import { PLANS, WORK, DATA, RUN as RUN_DIR, PROJECTS, HOME, GOALS, setupState, pathsInfo } from './paths.mjs'; // AGENTGLIM_PLANS / AGENTGLIM_WORK / AGENTGLIM_DATA
import { detect as setupDetect, loadSetup, saveSetup, completeSetup, setupView, jevSetupEndpoint, FREE_APIS, HARNESSES, SUBS, setupCatalog, credentialSet } from './setup.mjs'; // first-run Setup page (2026-11-11)
const RUN = RUN_DIR;
// tracked jobs: jobs-track writes one JSON per job here; the reaper marks ended ones done/failed
const TJ_DIR = `${DATA}/tracked-jobs`;
let tjCache = { at: 0, g: null };
const FEAT_FILE = `${DATA}/feature-subitems.json`; // finished feature-sized jobs per plan, kept for good
const trackedNow = () => { if (Date.now() - tjCache.at > 10000) { /* 10 s (was 2 s): CPU fix 2026-11-13 */ const activity = subagentStatus(liveJobs(readTracked(TJ_DIR))); const all = activity.jobs; tjCache = { at: Date.now(), subagents:activity, g: groupJobs(visibleJobs(all), { folds: foldNotes(PLANS) }), feats: saveFeatures(FEAT_FILE, all) }; } return tjCache.g; };
// SuperAgent row (2026-11-12): besides its transcript-live helpers (superagent.mjs, 3 min mtime window), it counts its
// headless queue takes (headless-take.sh, on any plan) and the Agent-tool subagents of its sessions the register still runs.
// Jobs owned by the SuperAgent itself (project "SuperAgent": observatory__* requests) are its sub-tasks; plan jobs stay on their plan.
const saJobs = (wr) => {
  if (!wr) return wr;
  trackedNow();
  const all = tjCache.subagents?.jobs || [], day = new Date().setHours(0, 0, 0, 0), sids = new Set((wr.sessions || []).map((x) => x.id));
  const headless = (j) => /^headless-take/.test(j.launcher || ''), sub = (j) => j.kind === 'subagent' && j.sessionId && sids.has(j.sessionId);
  const mine = (j) => j && (headless(j) || j.project === 'SuperAgent' || sub(j));
  const seen = new Set((wr.live || []).map((h) => h.id));
  const run = all.filter((j) => mine(j) && shownStatus(j) === 'running' && !seen.has(j.agentId) && !seen.has(j.id));
  const doneToday = all.filter((j) => mine(j) && !sub(j) && shownStatus(j) !== 'running' && (j.ended || 0) >= day).length; // finished subagents are in wr.done already
  const live = [...(wr.live || []), ...run.map((j) => ({ id: j.id, task: `${j.label || 'job'}${j.project && j.project !== 'SuperAgent' && j.project !== UNASSIGNED ? ` (${j.project})` : ''}${headless(j) ? ' · headless' : ''}`, model: j.model, tokens: 0, since: j.started }))];
  return { ...wr, live, running: live.length, done: (wr.done || 0) + doneToday, headlessRunning: run.filter(headless).length,
    tracked: visibleJobs(all.filter((j) => j && j.project === 'SuperAgent')) };
};
const featuresOf = (dir) => { const g = trackedNow(), folds = foldNotes(PLANS); return displayLiveStatus((tjCache.feats || []).filter((x) => x.plan === dir || folds[x.plan]?.parent === dir).map((x) => (x.plan !== dir ? { ...x, viaPlan: x.plan } : x)).map((x) => ({ ...x, status: x.status || 'done' })), dir, g.plans.get(dir) || []).sort((a, b) => (b.finished || '').localeCompare(a.finished || '')); };
// the run's scripts use the symlinked path above; Claude Code and OpenCode record the real one, Codex a file:// URI
const PLANS_REAL = (() => { try { return fs.realpathSync(PLANS); } catch { return PLANS; } })();
const toPlans = (p) => p && p.replace(/^file:\/\//, '').replace(PLANS_REAL, PLANS);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// page code id (index.html + its scripts/styles): a deploy changes it, a restart does not
const pageBuildId = makeBuildId(HERE);
const OPENCODE_DB = `${process.env.HOME}/.local/share/opencode/opencode.db`;
let PORT = Number(process.argv[2] ?? process.env.PORT ?? 18990);
let pagesPort = PORT === 0 ? 0 : PORT + 1;
// New-release check: one cached GitHub GET per 12 h at most. "dev" builds and opt-outs never fetch.
const UPDATE_ENABLED = updateCheckEnabled({ integrations });
const CURRENT_VERSION = currentVersion();
let updateState = null, updateBusy = null;
function refreshUpdate() {
  if (!UPDATE_ENABLED) return Promise.resolve(updateState || versionStatus({ data: DATA, current: CURRENT_VERSION, enabled: false }));
  if (!updateBusy) updateBusy = checkForUpdate({ data: DATA, current: CURRENT_VERSION, enabled: true })
    .then((s) => (updateState = s)).catch(() => null).finally(() => { updateBusy = null; });
  return updateBusy;
}
const currentUpdateStatus = () => updateState || versionStatus({ data: DATA, current: CURRENT_VERSION, enabled: UPDATE_ENABLED });
const BUCKET_MS = 10 * 60 * 1000;
const DS_CAP_USD = 50;

// provider -> billing class shown on the dashboard
const CLASS = {
  'opencode-go': 'subscription', codex: 'subscription', openai: 'subscription', anthropic: 'subscription',
  opencode: 'free', openrouter: 'free', antigravity: 'free',
  groq: 'free', 'google-ai-studio': 'free', cloudflare: 'free', cfai: 'free', // cfai = Cloudflare Workers AI's pi provider id (count it in the free card)
  // free-tier API workers (2026-11-06)
  deepseek: 'paid-api', jev: 'paid-api',
  elevenlabs: 'paid-api', // media provider (voice, sound effects, music), not an LLM
  'claude-cloud': 'other', // cloud credit, kept apart from the subscription
  qwen: 'local', 'llama.cpp': 'local', ollama: 'local',
};
const classOf = (provider) => CLASS[provider] || 'other';
// local model display names: Qwen3.6 A3B is the llama.cpp pilot on :8096.
// Strata runs qwen3.8-flash-next-iq3_xxs (retired; gets its own display row) and QFN Coder.
// Historical records keep the real model id; display names separate them for the card.
const LOCAL_MODELS = 'Qwen3.6-35B-A3B (on demand, :8096) · Qwen Flash Next Coder (Strata, :8080)';
const localShort = (provider, model) => {
  if (provider === 'qwen') {
    if (/qwen3\.8/i.test(model || '')) return 'Qwen3.8 Flash Next (Strata)'; // retired model, own entry
    return 'Qwen (Strata)';
  }
  return /qwen3\.6/i.test(model || '') ? 'Qwen3.6 A3B' : model;
};
const localName = (provider, model) => provider === 'qwen' ? localShort(provider, model) : `${localShort(provider, model)} (local)`;
// per usage record: OpenRouter is free only on its free models; OpenCode Go's *-free models are free too
const isFree = (r) => /free/i.test(r.model || '') || /^stealth\//i.test(r.model || ''); // OpenRouter stealth/ models are $0
const recClass = (r) => r.provider === 'openrouter' ? (isFree(r) ? 'free' : 'paid-api')
  : r.provider === 'opencode-go' && isFree(r) ? 'free' : classOf(r.provider);

// $ per million tokens, from leads/model_prices.json (closest listed model)
const PRICE = {
  // DeepSeek direct, blended from the billing export in human-loaded-data (2026-10-16: base 0.15/0.003/0.60
  // plus a small share billed at 2x). Pi's own cost overprices cache hits about 5x, so DeepSeek is priced here.
  dsFlash: { input: 0.1541, cached: 0.0030, output: 0.6002 },
  codex: { input: 2.0, cached: 0.10, write: 2.5, output: 10.0 },          // gpt-6.1-sol list price, short context (<272k)
  luna: { input: 0.2, cached: 0.01, write: 0.25, output: 1.2 },          // gpt-6-luna: sol price at the gpt-5.6 luna/sol ratio (unlisted)
  opus: { input: 4.0, cached: 0.20, write: 5.0, output: 20.0 },            // claude-opus-5-5 (5-min cache write = 1.25x)
  sonnet: { input: 2.0, cached: 0.10, write: 2.5, output: 10.0 },          // claude-sonnet-5-5 (ledger 2026-10-27)
  haiku: { input: 0.10, cached: 0.01, write: 0.125, output: 0.50 },        // claude-haiku-5-5
};
// Rough quality vs the primary worker (DS4.1 Flash): how much of a DS token a free/local token is worth
const QUALITY = [[/deepseek/i, 1.0], [/big-pickle/i, 0.6], [/space-bunny/i, 0.5], [/qwen|llama/i, 0.5], [/openrouter/i, 0.5]];
const qualityOf = (model) => (QUALITY.find(([re]) => re.test(model || '')) || [, 0.5])[1];
const codexPrice = (model) => /luna/i.test(model || '') ? PRICE.luna : PRICE.codex;
const codexCost = (t, model) => { const p = codexPrice(model); return (t.input * p.input + t.cached * p.cached + (t.write || 0) * p.write + t.output * p.output) / 1e6; };
const claudePrice = (model) => /sonnet/i.test(model) ? PRICE.sonnet : /haiku/i.test(model) ? PRICE.haiku : PRICE.opus;
// list prices for other paid models (OpenRouter paid, OpenCode Go non-DeepSeek), from leads/model_prices.json
let LIST = {};
try { if (LEDGER) LIST = JSON.parse(readText(LEDGER)).models || {}; } catch {}
function listPrice(model) {
  const k = Object.keys(LIST).find((x) => x === model || x.endsWith(`/${model}`));
  const c = k && LIST[k].current;
  return c ? { input: c.input, cached: c.cached_input ?? c.input, write: c.cache_write ?? c.input, output: c.output } : null;
}
// rates for one usage record: what it costs (paid), would cost on the API (subscription), or is worth (free/local, at DS Flash)
function rateOf(r) {
  if (r.provider === 'codex') return codexPrice(r.model);
  if (r.provider === 'anthropic') return claudePrice(r.model);
  if (r.provider === 'deepseek' || /deepseek/i.test(r.model)) return PRICE.dsFlash;
  if (r.provider === 'antigravity') return agyPrice(r.model) || PRICE.dsFlash;
  const cls = recClass(r);
  return (cls !== 'free' && cls !== 'local' && listPrice(r.model)) || PRICE.dsFlash;
}
const partCost = (r, p) => (r.input * p.input + r.cacheRead * p.cached + (r.cacheWrite || 0) * (p.write ?? p.input) + r.output * p.output) / 1e6;
// cache reads billed at the cached rate instead of full input, less the premium paid to write the cache
const cacheSaved = (r, p) => (r.cacheRead * (p.input - p.cached) - (r.cacheWrite || 0) * ((p.write ?? p.input) - p.input)) / 1e6;
// Antigravity's own rate table: each agy model at its live OpenRouter list price ($/M), refreshed daily,
// cached in data/agy-prices.json; a model with no price yet falls back to DS4.1 Flash
const AGY_OR = [[/^gemini-3\.8-flash/, 'google/gemini-3.8-flash'], [/^claude-opus-4-6/, 'anthropic/claude-opus-4.6'], [/^claude-sonnet-4-6/, 'anthropic/claude-sonnet-4.6'], [/^gpt-oss-120b/, 'openai/gpt-oss-120b']];
const AGY_FILE = `${DATA}/agy-prices.json`; let AGY_P = {}; try { AGY_P = JSON.parse(readText(AGY_FILE)); } catch {}
const agyPrice = (model) => { const id = AGY_OR.find(([re]) => re.test(model || ''))?.[1]; const c = id && AGY_P.models?.[id]; return c ? { ...c, id } : null; };
function agyPriceRefresh() {
  fetch('https://openrouter.ai/api/v1/models').then((r) => r.json()).then((j) => { const models = {}, M = 1e6;
    for (const [, id] of AGY_OR) { const x = (j.data || []).find((m) => m.id === id)?.pricing; if (x) models[id] = { input: +x.prompt * M, cached: +(x.input_cache_read ?? x.prompt) * M, write: +(x.input_cache_write ?? x.prompt) * M, output: +x.completion * M }; }
    if (Object.keys(models).length) { AGY_P = { at: new Date().toISOString(), source: 'https://openrouter.ai/api/v1/models', models }; fs.writeFileSync(AGY_FILE, JSON.stringify(AGY_P, null, 2)); }
  }).catch((e) => console.error('agy price refresh failed', e.message));
}
const dsCost = (u) => (u.input * PRICE.dsFlash.input + u.cacheRead * PRICE.dsFlash.cached + u.output * PRICE.dsFlash.output) / 1e6;
// subscription prices, $ per month (OpenCode Go: two $10 subscriptions, opencode-go and opencode-go2)
const SUB_PRICE = {};
function updateSubscriptionPrices() { const totals=subscriptionTotals(loadSetup()); Object.assign(SUB_PRICE, {anthropic:totals.claude,codex:totals.codex,'opencode-go':totals.go}); }
updateSubscriptionPrices();
// earlier prices, oldest first: [until (ms), $ per month]. Claude moved from $20 to the $100 plan on 2026-10-18 06:40.
const SUB_HISTORY = {}; // Historical billing belongs in private data, never source defaults.
// the flat price prorated over [lo, hi] at $price/30 per day, each stretch at the price it had then
function subProrated(prov, lo, hi) {
  let total = 0, start = -Infinity;
  for (const [until, price] of [...(SUB_HISTORY[prov] || []), [Infinity, SUB_PRICE[prov]]]) {
    const a = Math.max(lo, start), b = Math.min(hi, until);
    if (b > a) total += (b - a) / 86400e3 * price / 30;
    start = until;
  }
  return total;
}
// DeepSeek billing exports dropped in by hand: cost-*.csv with start_time_iso, model, wallet_type, cost
const BILLING = `${WORK}/human-loaded-data`;
let billed = { rows: [], sig: '' };
function loadBilling() {
  let files = [];
  try { files = fs.readdirSync(BILLING).filter((f) => /^cost-.*\.csv$/.test(f)); } catch { return; }
  const sig = files.map((f) => f + fs.statSync(`${BILLING}/${f}`).mtimeMs).join();
  if (sig === billed.sig) return;
  const rows = new Map(); // de-duplicated across overlapping exports
  for (const f of files) {
    const [head, ...lines] = readText(`${BILLING}/${f}`).replace(/^\uFEFF/, '').trim().split('\n');
    const cols = head.split(',');
    for (const l of lines) {
      const v = Object.fromEntries(l.split(',').map((x, i) => [cols[i], x]));
      rows.set(`${v.start_time_iso}|${v.model}|${v.wallet_type}`, { t: Date.parse(v.start_time_iso), model: v.model, wallet: v.wallet_type, cost: Number(v.cost) || 0 });
    }
  }
  billed = { rows: [...rows.values()], sig };
}
const PROBES = toPlans(`${WORK}/probes`); // one-off test calls, outside plans/NN-* so the driver never sees them
const CLAUDE_PROJECTS = `${process.env.HOME}/.claude/projects`;
const CLAUDE_RUN_PROJECTS = `${RUN}/claude-home/projects`; // Haiku workers' run-only Claude config (agent.sh CLAUDE_HOME)
const CODEX_SESSIONS = `${process.env.HOME}/.codex/sessions`;
// optional read-only copy of an older machine's run history, laid out as on that disk
const IMPORTED = `${WORK}/imported/wsl`;
const IMP_HOME = `${IMPORTED}${HOME}`;

fs.mkdirSync(DATA, { recursive: true });

// ---------- incremental file readers ----------
const fileState = new Map(); // path -> { size, offset, partial }
// Generator over new lines, read in 8 MB chunks so a 100+ MB transcript never sits in memory whole
// (memory-safe batch loading; the first full read used to peak the server at 5.4 GB).
const CHUNK = 8 << 20;
function* readNewLines(file) {
  let st;
  try { st = fs.statSync(file); } catch { return; }
  let s = fileState.get(file);
  if (!s || st.size < s.offset) { s = { offset: 0, partial: '' }; fileState.set(file, s); }
  if (st.size === s.offset) return;
  const end = st.size;
  let fd; try { fd = fs.openSync(file, 'r'); } catch { return; }
  try {
    const buf = Buffer.alloc(Math.min(CHUNK, end - s.offset));
    while (s.offset < end) {
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, end - s.offset), s.offset);
      if (n <= 0) break;
      s.offset += n;
      const lines = (s.partial + buf.toString('utf8', 0, n)).split('\n');
      s.partial = lines.pop();
      if (s.partial.length > 64 << 20) s.partial = ''; // a runaway line: drop it rather than grow forever
      yield* lines;
    }
  } finally { fs.closeSync(fd); }
}
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const exists = (f) => fs.existsSync(f);

// paid API key rows: local ledgers only, never key values, no API calls
const sumUsd = (f, since = 0) => readText(f).split('\n').reduce((t, l) => { try { const e = JSON.parse(l); return t + (e.at > since ? +e.usd || 0 : 0); } catch { return t; } }, 0);
function apiKeys() {
  let credit = null, modes = {};
  try { credit = JSON.parse(readText(`${RUN}/claude-api-credit.json`)); } catch {}
  try { modes = JSON.parse(readText(`${RUN}/modes.json`)); } catch {}
  const claudeTotal = credit ? (+credit.promoUsd || 0) + (+credit.purchasedUsd || 0) : null;
  const since = Date.parse((credit?.balanceAt || '').slice(0, 16).replace(' ', 'T')) || 0;
  const claudeSpent = sumUsd(`${RUN}/flags/api-spend.ndjson`);
  const spentSince = sumUsd(`${RUN}/flags/api-spend.ndjson`, since);
  return {
    claude: { keys:keyStatuses('ANTHROPIC_API_KEY'), spent: claudeSpent, total: claudeTotal, left: claudeTotal == null ? null : Math.max(0, claudeTotal - spentSince), balanceAt: credit?.balanceAt || null, expires: credit?.nextCredit || null, mode: modes.api || null },
    codex: { keys:keyStatuses('OPENAI_API_KEY',['OPENAI_API_KEY_DATA']), key:'OPENAI_API_KEY', spent: sumUsd(`${RUN}/flags/codex-api-spend.ndjson`), cap: +modes.codexApiStopUsd || 10, mode: modes.codexApi || null },
  };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------- job discovery ----------
const jobs = new Map(); // job dir -> job record (token totals accumulate across scans)
// jobs handed to a Claude subagent (bin/claudeq.sh): .req files with model= and done=<job dir>/claude.done
let claudeQueue = new Map(); // job dir -> { model: 'opus' | 'sonnet', taken }
function scanClaudeQueue() {
  const q = new Map();
  try {
    for (const f of fs.readdirSync(`${RUN}/audit_queue`).filter((n) => n.endsWith('.req'))) {
      const t = readText(`${RUN}/audit_queue/${f}`);
      const model = t.match(/^model=(\S+)/m)?.[1], done = t.match(/^done=(\S+)/m)?.[1];
      if (model && done) q.set(path.dirname(done), { model, taken: exists(`${RUN}/audit_queue/${f.slice(0, -4)}.taken`) });
    }
  } catch {}
  claudeQueue = q;
}
// usage records per 10-minute bucket, provider and model: the source for every date/provider-filtered view
const recs = new Map(); // `${t}|${provider}|${model}` -> { t, provider, model, input, output, cacheRead, cost, calls }
function addRec(ts, provider, model, input, output, cacheRead, cost, cacheWrite = 0, reasoning = 0) {
  const t = Math.floor(ts / BUCKET_MS) * BUCKET_MS;
  const k = `${t}|${provider}|${model || '?'}`;
  const r = recs.get(k) || { t, provider, model: model || '?', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, calls: 0 };
  r.input += input; r.output += output; r.cacheRead += cacheRead; r.cacheWrite += cacheWrite; r.reasoning += reasoning;
  r.cost += cost; r.calls += 1;
  if (r.provider === 'strata') r.provider = 'qwen'; // Strata runs Qwen
  recs.set(k, r);
}

function roleOf(rel) {
  // rel: NN-slug/_build/<...>, or _observatory/probes/<name> for one-off test calls
  const p = rel.split('/');
  if (p[0] === '_observatory' || p[0] === '_agentglim') return { project: '(probe)', step: 'probe', role: 'probe', task: p[2] };
  // archived run attempts: _run/archive-run1/NN-slug/_build/<...>, labelled run1/NN-slug so they stay out of the live project rows
  if (p[0] === '_run' && p[1]?.startsWith('archive-')) {
    const tag = p[1].slice(8);
    if (p[3] === '_build') { const r = roleOf([p[2], ...p.slice(3)].join('/')); return { ...r, project: `${tag}/${r.project}` }; }
    return { project: `${tag}/${p[2]}`, step: tag, role: 'job', task: p.slice(3).join('/') };
  }
  const project = p[0];
  const step = p[2];
  if (step === 'p1') return { project, step, role: 'plan builder', task: 'write plan' };
  if (step === 'focus') return { project, step, role: 'focus check', task: 'BUILD-V2.md' };
  if (step === 'verify') return { project, step, role: 'verifier', task: 'VERIFY.md' };
  // revision steps from driver.mjs reopen: v3-focus writes BUILD-V3.md, v3-verify a fresh VERIFY.md
  if (/^v\d+-focus$/.test(step)) return { project, step, role: 'focus check', task: `BUILD-V${step.slice(1, -6)}.md` };
  if (/^v\d+-verify$/.test(step)) return { project, step, role: 'verifier', task: 'VERIFY.md' };
  if (p[3] === 'orch') return { project, step, role: 'orchestrator', task: `round ${step}` };
  if (p[3] === 'audit') return { project, step, role: 'auditor', task: `audit ${step}` };
  if (p[3] === 'workers') {
    const free = p[5] && p[5].startsWith('free-') ? p[5].slice(5) : null;
    return { project, step, role: free ? 'worker (free)' : 'worker', task: p[4], slot: free || p[5] || null };
  }
  return { project, step, role: 'job', task: p.slice(2).join('/') };
}

let jobDirs = null, jobDirsAt = 0;
function walkJobs() {
  const found = [];
  let planDirs = []; try { planDirs = fs.readdirSync(PLANS); } catch {} // no plans folder yet (fresh install)
  for (const d of planDirs) {
    if (!/^\d\d-/.test(d)) continue;
    const root = `${PLANS}/${d}/_build`;
    const walk = (dir, depth) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      if (ents.some((e) => e.name === 'meta' && e.isFile())) found.push(dir);
      if (depth > 4) return;
      for (const e of ents) if (e.isDirectory() && e.name !== 'session' && e.name !== 'tasks') walk(`${dir}/${e.name}`, depth + 1);
    };
    walk(root, 0);
  }
  try { for (const d of fs.readdirSync(PROBES)) if (exists(`${PROBES}/${d}/meta`)) found.push(`${PROBES}/${d}`); } catch {}
  // jobs with transcripts in the imported copy (it holds only session/ and events.jsonl)
  const imp = (dir) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.name === 'session' || e.name === 'events.jsonl')) found.push(dir.slice(IMPORTED.length));
    for (const e of ents) if (e.isDirectory() && e.name !== 'session') imp(`${dir}/${e.name}`);
  };
  imp(`${IMPORTED}${PLANS}`);
  return [...new Set(found)];
}

// out dirs of running agent.sh processes (agent.sh KIND CWD PROMPT OUT ...). Pid files can hold
// sandbox-namespace pids, so the process list is the source of truth for what is running.
let liveDirs = new Set();
let auditqArmed = false; // bin/auditq-wait.sh running (status digest health)
// out dirs whose agent (or a process under it) is SIGSTOPped: limit-pause.sh, goal.sh pause, an owner stop
let stoppedDirs = new Set();
// interactive `claude` sessions the owner runs inside a plan folder (manual handoffs, not driver jobs): plan dir -> pids
let manualSessions = new Map();
const MANUAL_IDLE_MS = 30 * 60e3;
const promptCache = new Map(); // transcript path -> { mtime, at, model }
// time of the owner's last typed prompt: newest `user` entry whose content is a string (tool results are arrays);
// model: the newest assistant entry's model (the dashboard draws that model's icon for the manual session)
function sessionMeta(file) {
  let st; try { st = fs.statSync(file); } catch { return { at: 0, model: null }; }
  const c = promptCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c;
  let at = 0, model = null;
  try {
    // tail only: last 4 MB, widened to 32 MB if the prompt/model is not in it (was a full read on every change)
    let lines = [];
    for (const span of [4 << 20, 32 << 20]) {
      const n = Math.min(span, st.size), fd = fs.openSync(file, 'r'), b = Buffer.alloc(n);
      fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd);
      lines = b.toString('utf8').split('\n'); if (n < st.size) lines.shift();
      if (lines.some((l) => l.includes('"type":"user"')) && lines.some((l) => l.includes('"model":"')) || n === st.size) break;
    }
    for (let i = lines.length - 1; i >= 0 && !(at && model); i--) {
      const ln = lines[i];
      if (!model && ln.includes('"type":"assistant"') && ln.includes('"model":"')) {
        try { const m = JSON.parse(ln).message?.model; if (m && !m.startsWith('<')) model = m; } catch {}
      }
      if (at || !ln.includes('"type":"user"') || ln.includes('"isMeta":true')) continue;
      try { const j = JSON.parse(ln); if (typeof j.message?.content === 'string' && !j.isCompactSummary) at = Date.parse(j.timestamp) || 0; } catch {}
    }
  } catch {}
  const out = { mtime: st.mtimeMs, at, model };
  promptCache.set(file, out);
  return out;
}
const lastPromptAt = (file) => sessionMeta(file).at;
// ~/.claude/sessions/<pid>.json gives the session id, name and busy/idle status
function manualInfo(pid, cwd) {
  let s = {}; try { s = JSON.parse(fs.readFileSync(`${process.env.HOME}/.claude/sessions/${pid}.json`, 'utf8')); } catch {}
  const file = s.sessionId && `${process.env.HOME}/.claude/projects/${(s.cwd || fs.realpathSync(cwd)).replace(/[^A-Za-z0-9]/g, '-')}/${s.sessionId}.jsonl`;
  const { at, model } = file ? sessionMeta(file) : { at: 0, model: null };
  const idle = s.status === 'idle' && Date.now() - (at || s.startedAt || 0) > MANUAL_IDLE_MS;
  return { pid, name: s.name || `pid ${pid}`, status: s.status || null, lastPrompt: at || null, idle, file, model };
}
// interactive agents outside any plan folder (other projects, ~) -> Active builds "other" rows
const AGENT_BINS = new Set(['claude', 'codex', 'opencode', 'pi']);
let otherSessions = [];
const manualWork = (m) => ({ provider: !m.agent || m.agent === 'claude' ? 'manual' : m.agent, agent: m.agent || 'claude', role: 'manual', task: `session ${m.name}`, model: m.model || null, status: m.status, lastPrompt: m.lastPrompt, idle: m.idle, paused: m.idle, pane: m.pane || null });
// plan a plans/-level session works on: the last `plans/NN-slug` or `_observatory` path in its transcript's last 256 KB
const planCache = new Map(); // file -> { mtime, d }
function planOfSession(file) {
  if (!file) return null;
  let st; try { st = fs.statSync(file); } catch { return null; }
  const c = planCache.get(file);
  if (c && c.mtime === st.mtimeMs) return c.d;
  let d = null;
  try {
    const n = Math.min(st.size, 256 * 1024), buf = Buffer.alloc(n), fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, n, st.size - n); } finally { fs.closeSync(fd); }
    const hits = buf.toString('utf8').match(/plans\/(\d\d-[a-z0-9-]+|_observatory)/g);
    if (hits) d = Buffer.from(hits.at(-1).slice(6)).toString();
  } catch {}
  planCache.set(file, { mtime: st.mtimeMs, d });
  return d;
}
// tmux pane of each headed session (title + location) for the agent icon tooltip;
// refreshed async on every scan, so a scan uses the previous scan's pane list
let paneByTty = new Map();
const DEFAULT_PANE_TITLES = new Set(['bash', 'zsh', 'sh', 'claude', 'codex', 'pi', 'opencode', os.hostname()]);
function refreshPanes() {
  execFile('tmux', ['list-panes', '-a', '-F', '#{pane_tty}\t#{pane_id}\t#{pane_title}\t#{session_name}:#{window_index}.#{pane_index}'], { timeout: 2000 }, (e, out) => {
    if (e) { if (!refreshPanes.warned) { refreshPanes.warned = 1; console.error('tmux panes:', e.message); } return; } const m = new Map();
    for (const l of String(out).split('\n')) { const [tty, id, title, loc] = l.split('\t'); if (tty) m.set(tty, { id, title: DEFAULT_PANE_TITLES.has(title) ? '' : title, loc }); }
    paneByTty = m; });
}
// tty_nr (major 136 = /dev/pts) -> the pane on that pts
const paneOf = (tty) => { if ((tty >> 8 & 0xfff) < 136 || (tty >> 8 & 0xfff) > 143) return null; const n = (tty & 0xff) | ((tty >> 12) & 0xfff00) | (((tty >> 8 & 0xfff) - 136) << 8); return paneByTty.get(`/dev/pts/${n}`) || null; };
// Cross-OS path helpers: argv and cwd arrive with native separators (\\ on Windows), so
// comparisons go through '/' and never assume the Linux one. `relUnder` returns the
// '/'-joined relative path when `child` is inside `parent`, else null.
const slashPath = (s) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '');
const relUnder = (child, parent) => {
  const c = slashPath(child), base = slashPath(parent);
  return c === base ? '' : c.startsWith(`${base}/`) ? c.slice(base.length + 1) : null;
};
function scanLive() {
  refreshPanes();
  const s = new Set(), m = new Map(), tree = new Map(), agentOut = new Map(), ttys = new Set(), other = []; let armed = false;
  for (const { pid: p, ppid, state, args: a, cwd: processCwd, tty } of listProcesses()) {
    tree.set(p, { state, ppid });
    const argv = a.map(slashPath);
    const i = argv.findIndex((x) => x.endsWith('/agent.sh'));
    if (argv.some((x) => x.endsWith('/auditq-wait.sh') || x.endsWith('/watcher-bridge.py'))) armed = true;
    if (i >= 0 && a[i + 4]) { const pc = processCwd || '/'; const o = toPlans(path.resolve(pc, a[i + 4])); s.add(o); agentOut.set(+p, o); } // relative to agent.sh's cwd, not ours
    // Driver jobs (`claude -p`) have no terminal; owner sessions do.
    // every interactive claude/codex/opencode/pi in any folder; one per terminal; a session
    // started at plans/ itself is put on the plan its transcript tail touched last (no model call)
    const bin = [a[0], a[1]].map((x) => path.basename(x || '')).find((x) => AGENT_BINS.has(x));
    if (bin && !a.includes('-p') && !a.includes('exec') && !(bin === 'opencode' && a.includes('run'))) {
      if (!tty || ttys.has(tty)) continue;
      ttys.add(tty);
      if (!processCwd) continue;
      const cwd = toPlans(processCwd);
      const inPlans = relUnder(cwd, PLANS);
      const info = bin === 'claude' ? manualInfo(+p, cwd) : { pid: +p, name: `${bin} pid ${p}`, status: null, lastPrompt: null, idle: false };
      info.agent = bin;
      const pane = paneOf(tty); if (pane) info.pane = pane;
      let d = inPlans !== null && inPlans.split('/')[0];
      if (!(d && (/^\d\d-/.test(d) || d === '_observatory')) && inPlans !== null) d = planOfSession(info.file) || null;
      if (d && (/^\d\d-/.test(d) || d === '_observatory')) m.set(d, [...(m.get(d) || []), info]);
      else {
        const project = relUnder(cwd, PROJECTS);
        other.push({ ...info, project: inPlans !== null ? 'plans' : slashPath(cwd) === slashPath(HOME) ? '~' : project !== null && goodProject(project.split('/')[0]) ? project.split('/')[0] : UNASSIGNED });
      }
    }
  }
  const stopped = new Set();
  for (const [pid, t] of tree) {
    if (t.state !== 'T') continue;
    for (let q = pid, n = 0; q > 1 && n < 30; q = tree.get(q)?.ppid, n++) if (agentOut.has(q)) { stopped.add(agentOut.get(q)); break; }
  }
  liveDirs = s; auditqArmed = armed;
  stoppedDirs = stopped;
  manualSessions = m; otherSessions = other;
}

// URL route, not a filesystem path: built from parts so a grep for proc paths only finds the proc root.
const PROCESS_GUARD_ROUTE = '/' + 'process-guard';

function parseMeta(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  const m = { started: null, ended: null, kind: null, provider: null, rc: null, notes: [] };
  for (const l of lines) {
    const t = Date.parse(l.slice(0, 19).replace(' ', 'T'));
    let x;
    if ((x = l.match(/ start kind=(\S+)/))) { m.started = m.started || t; m.kind = x[1]; }
    else if ((x = l.match(/ pi provider=(\S+)/))) m.provider = x[1];
    else if ((x = l.match(/ end kind=(\S+) rc=(\S+)/))) { m.ended = t; m.kind = m.kind || x[1]; m.rc = x[2]; } // the last start's kind wins: a codex-only run that fell back to pi logs end kind=codex-only (2026-11-04)
    else if (/ queue: queued /.test(l)) { (m.queued ||= []).push(t); m.notes.push(l.slice(20)); }
    else if (/ queue: taken /.test(l)) { (m.taken ||= []).push(t); m.notes.push(l.slice(20)); }
    else if ((x = l.match(/unavailable; retrying in (\d+) min/))) { m.provWaitMin = (m.provWaitMin || 0) + Number(x[1]); m.notes.push(l.slice(20)); }
    else m.notes.push(l.slice(20));
  }
  return m;
}

function scanJob(dir) {
  const rel = path.relative(PLANS, dir);
  let j = jobs.get(dir);
  if (!j) {
    j = { dir, rel, ...roleOf(rel), tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, calls: 0,
      byProvider: {}, model: null, lastMsg: null };
    jobs.set(dir, j);
  }
  const meta = parseMeta(readText(`${dir}/meta`));
  // the same dir can hold several runs (pi(none) yesterday, codex-only today): drop the old run's model when the kind changes
  if (j.kind && meta.kind !== j.kind) { j.model = null; j.providerKey = null; }
  Object.assign(j, { started: meta.started, ended: meta.ended, kind: meta.kind, provider: meta.provider, notes: meta.notes.slice(-4) });
  // waits: watcher-queue wait (queued -> taken, from claudeq notes) and provider-unavailable retries
  { const qd = meta.queued || [], tk = meta.taken || []; let w = 0;
    qd.forEach((t, i) => { const e = tk.find((x) => x >= t && (i + 1 >= qd.length || x < qd[i + 1])) ?? (i === qd.length - 1 && !meta.ended ? Date.now() : null); if (e) w += e - t; });
    j.queueWaitMin = qd.length ? Math.round(w / 60000) : null; j.provWaitMin = meta.provWaitMin || 0; }
  const rcFile = readText(`${dir}/rc`).trim();
  j.rc = rcFile || null;
  const q = claudeQueue.get(dir);
  j.active = (!rcFile && liveDirs.has(dir)) || (!!q?.taken && !exists(`${dir}/claude.done`));
  j.stopped = j.active && stoppedDirs.has(dir);
  // alive but parked in agent.sh's 15-min retry loop (usage gate / waiting for a reset)
  j.waiting = j.active && !q?.taken && /retrying in \d+ min|not started/.test(meta.notes.at(-1) || '');
  const codexModel = j.kind === 'luna' ? meta.notes.map((n) => n.match(/^luna: (gpt\S+)$/)?.[1]).find(Boolean) || 'gpt-6-luna' : meta.notes.map((n) => n.match(/^premium model: (gpt\S+)$/)?.[1]).filter(Boolean).at(-1) || 'gpt-6.1-sol';
  // Pi sessions, live and from the imported copy
  const sfiles = [];
  for (const sd of [`${dir}/session`, `${IMPORTED}${dir}/session`]) {
    try { for (const f of fs.readdirSync(sd)) if (f.endsWith('.jsonl')) sfiles.push(`${sd}/${f}`); } catch {}
  }
  for (const f of sfiles) {
    for (const line of readNewLines(f)) {
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const msg = o.message || {};
      const u = msg.usage || {};
      const tok = (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
      // Pi's "openai" provider is the Codex subscription (Luna6 agents): chart it as Codex, priced as an API estimate.
      // "opencode-go2" is a second API key on the same OpenCode Go plan: one provider, two subscriptions
      const prov = msg.provider === 'openai' ? 'codex' : (msg.provider === 'google' || (j.kind?.startsWith('gofree:google/') && /^google\//.test(msg.model || ''))) ? 'google-ai-studio' : msg.provider === 'opencode-go2' ? 'opencode-go' : msg.provider || 'unknown';
      const cost = prov === 'deepseek' ? dsCost({ input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0 })
        : prov === 'codex' ? codexCost({ input: u.input || 0, cached: u.cacheRead || 0, write: u.cacheWrite || 0, output: u.output || 0 }, msg.model)
        : u.cost?.total || 0;
      account(j, prov, msg.model, u.input || 0, u.output || 0, u.cacheRead || 0, cost,
        msg.timestamp || Date.parse(o.timestamp) || Date.now(), tok, u.cacheWrite || 0, 0, true);
    }
  }
  // Codex events
  for (const line of [`${dir}/events.jsonl`, `${IMPORTED}${dir}/events.jsonl`].flatMap((f) => [...readNewLines(f)])) {
    if (!line.includes('turn.completed')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const u = o.usage || {};
    const inp = (u.input_tokens || 0) - (u.cached_input_tokens || 0);
    const tok = (u.input_tokens || 0) + (u.output_tokens || 0);
    // priced at the Sol/Luna list rate (was 0, so 10 premium Codex verifies showed $0); chart stays off, no double count
    account(j, 'codex', codexModel, inp, u.output_tokens || 0, u.cached_input_tokens || 0,
      codexCost({ input: inp, cached: u.cached_input_tokens || 0, output: u.output_tokens || 0 }, codexModel), Date.now(), tok);
  }
  if (j.kind && (j.kind.startsWith('codex') || j.kind === 'luna') && !j.model) j.model = codexModel;
  // gofree:<pi provider>/<model>: show the model before the first message (runs that fail at once never send one)
  if (j.kind && j.kind.startsWith('gofree:') && !j.model) j.model = j.kind.slice(7).replace(/^(groq|google|cfai|opencode-go2?)\//, '');
  if (j.kind && j.kind.startsWith('zen:')) { j.model = j.kind.slice(4); j.providerKey = 'opencode'; }
  // Antigravity (agy): one JSON object with the usage at the end of the run
  if (j.kind && j.kind.startsWith('agy:')) {
    j.model = j.kind.slice(4); j.providerKey = 'antigravity';
    let st = null; try { st = fs.statSync(`${dir}/agy.json`); } catch {}
    if (st && st.size && j.agySeen !== st.mtimeMs) {
      j.agySeen = st.mtimeMs;
      let o = {}; try { o = JSON.parse(readText(`${dir}/agy.json`)); } catch {}
      const u = o.usage || {};
      if (u.total_tokens) account(j, 'antigravity', j.model, u.input_tokens || 0, u.output_tokens || 0, // input_tokens excludes cache reads (161k vs 1.03M cached), no subtraction
        u.cache_read_tokens || 0, 0, st.mtimeMs, u.total_tokens, 0, u.thinking_tokens || 0, true);
    }
  }
  // rc 75: agent.sh never started the agent (no provider / usage gate) or stopped it on a usage limit; its last note says which
  const why = j.rc === '75' ? [...meta.notes].reverse().find((n) => /not started|limit hit/.test(n)) || 'not started' : null;
  j.skip = why && { kind: /limit hit/.test(why) ? 'limit' : 'skipped', why: why.replace(/^[\w-]+: /, '') };
  // Pi with no DeepSeek provider left (Go limited, direct capped): it would have run DeepSeek v4.1 Flash
  if (j.kind === 'pi(none)') { j.model = j.model || 'deepseek-v4.1-flash'; j.providerKey = j.providerKey || 'deepseek'; }
  // Haiku workers: headless claude -p under _run/claude-home; tokens come from haikuUsage() after the Claude scan
  if (j.kind === 'haiku') {
    j.providerKey = 'anthropic';
    j.model = meta.notes.map((n) => n.match(/^haiku: (claude-\S+)$/)?.[1]).find(Boolean) || j.model || 'claude-haiku-5-5';
  }
  // Sonnet orchestrators (agent.sh sonnet): the model is in the newest "sonnet: <model>" note (a takeover dir also holds luna notes)
  if (j.kind === 'sonnet') {
    j.providerKey = 'anthropic'; // the current run; an earlier luna run in the same dir set codex
    j.model = meta.notes.map((n) => n.match(/^sonnet: (claude-\S+)$/)?.[1]).filter(Boolean).at(-1) || j.model || 'claude-sonnet-5-5';
  }
  // Claude subagent jobs run in the watching session: queued in _run/audit_queue, finished with claude.done.
  // Premium jobs (focus, final audit, verify) wait for Opus unless they fell back to Codex.
  const premiumCodex = j.kind === 'premium' && meta.notes.some((n) => /premium: codex/.test(n));
  if (q || exists(`${dir}/claude.done`) || (j.kind === 'premium' && !premiumCodex)) {
    j.claude = q?.model || meta.notes.map((n) => n.match(/^premium: done by (fable|opus48|opus) subagent$/)?.[1]).filter(Boolean).at(-1) || (j.kind === 'premium' ? 'opus' : ['opus', 'opus48', 'fable'].includes(j.kind) ? j.kind : 'sonnet');
    j.model = claudeKindId(j.claude); // opus48 -> claude-opus-4-8 (follow-up 2026-11-13: was shown as Sonnet)
  } else if (premiumCodex) { j.claude = null; j.model = codexModel; }
  j.premiumCodex = premiumCodex;
  return j;
}

function account(j, provider, model, input, output, cacheRead, cost, ts, tok, cacheWrite = 0, reasoning = 0, chart = provider !== 'codex') {
  j.tokens.input += input; j.tokens.output += output; j.tokens.cacheRead += cacheRead; j.tokens.cacheWrite += cacheWrite;
  j.cost += cost; j.calls += 1; j.model = model || j.model; j.providerKey = provider; j.lastMsg = ts;
  const p = (j.byProvider[provider] ||= { tokens: 0, cost: 0, calls: 0 });
  p.tokens += tok; p.cost += cost; p.calls += 1;
  // Codex CLI usage is charted from its session files (subRecs), which also cover these run jobs; Pi's Codex usage is not
  if (chart) addRec(ts, provider, model, input, output, cacheRead, cost, cacheWrite, reasoning);
}
// priced | estimated | free | running | skipped | not captured (finished paid job with no tokens recorded)
function costState(j) {
  if (j.cost) return 'priced';
  if (j.estCost) return 'estimated';
  if (j.active) return 'running';
  if (j.skip) return 'skipped';
  const prov = provOf(j);
  if (!['anthropic', 'codex', 'deepseek', 'openrouter', 'opencode'].includes(prov)) return 'free';
  return j.calls ? 'priced' : 'not captured';
}
// provider key of a job, also before its first model message arrives
const provOf = (j) => { const p = provOf0(j); return p === 'strata' ? 'qwen': p; }; // Strata runs Qwen
const provOf0 = (j) => j.kind === 'cloud' ? 'claude-cloud' : j.claude ? 'anthropic' : j.providerKey || (j.kind?.startsWith('codex') || j.kind === 'luna' || j.premiumCodex ? 'codex' : j.kind?.startsWith('zen:') ? 'opencode' : j.kind?.startsWith('agy:') ? 'antigravity'
  : j.kind?.startsWith('gofree:groq/') ? 'groq' : j.kind?.startsWith('gofree:google/') ? 'google-ai-studio' : j.kind?.startsWith('gofree:cfai/') ? 'cloudflare'
  : j.provider === 'go' || j.provider === 'go2' ? 'opencode-go' : j.provider === 'direct' ? 'deepseek' : j.provider === 'strata' ? 'qwen' : j.provider || j.classified?.provider || '');

// ---------- new kinds and models: classify, queue for review, ask Jev when the rules can't place them ----------
// First start: everything the run already handles is the approved baseline; only kinds/models seen after that need review.
// Haiku (added 2026-10-17) is left out so the panel has a first real item to check.
function seedBaseline() {
  if (fs.existsSync(`${DATA}/classes.json`)) return;
  const seed = new Map();
  for (const k of agentKinds()) seed.set(keyOf(k, null), { kind: k, model: null });
  for (const j of jobs.values()) if (j.kind) seed.set(keyOf(j.kind, j.model), { kind: j.kind, model: j.model });
  for (const [key, { kind, model }] of seed) {
    if (kindOf(kind) === 'haiku') continue;
    const prov = [...jobs.values()].find((j) => keyOf(j.kind, j.model) === key);
    const c = classify(kind, model);
    const provider = (prov && provOf(prov)) || c.provider;
    approve(key, { kind: kindOf(kind), model, provider, class: c.rule || !CLASS[provider] ? c.class : recClass({ provider, model }), source: 'baseline' });
  }
}
// Reject: one click sends a review item back to the watcher session. It writes a prompt under
// _observatory/_build/reject-<slug>/ and a Sonnet .req in the audit queue; the watcher takes it headless and the agent
// writes REPORT.md (what happened, whether the classification or the server is wrong) next to the prompt.
const REJECTS = `${DATA}/model-rejects.json`;
const loadRejects = () => { try { return JSON.parse(fs.readFileSync(REJECTS, 'utf8')); } catch { return {}; } };
const loadRejectsHist = (key) => (loadRejects()[key]?.count || 0) + 1; // this reject included
function rejectStatus(r) {
  if (!r) return null;
  const rep = readText(`${r.dir}/REPORT.md`).trim();
  if (rep) return { state: 'reviewed', at: r.at, summary: (rep.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '').slice(0, 240), report: `${r.dir}/REPORT.md` };
  return { state: fs.existsSync(`${RUN}/audit_queue/${r.req}.taken`) ? 'reviewing' : 'queued', at: r.at };
}
function rejectItem(key, note) {
  const it = (base?.review || []).find((i) => i.key === key) || null;
  const jobsOf = [...jobs.values()].filter((j) => j.kind && classify(j.kind, j.model).key === key).slice(0, 5);
  const slug = key.replace(/[^a-z0-9.-]+/gi, '_').slice(0, 60) + '-' + Date.now().toString(36);
  const dir = `${PLANS}/_observatory/_build/reject-${slug}`, req = `observatory__reject-${slug}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/prompt.md`, `# Observatory: owner rejected a "new model to review" item

The owner clicked Reject on this item in the Observatory's review card. Find out what happened and report.
${note ? `\nOwner's note: ${note}\n` : ''}
Item (as the Observatory showed it):
\`\`\`json
${JSON.stringify(it || { key }, null, 1)}
\`\`\`

Job dirs behind it (each has meta, events.jsonl / session logs, stderr.log):
${jobsOf.map((j) => `- ${j.dir} (kind ${j.kind}, model ${j.model || '-'}, provider ${j.provider || '-'})`).join('\n') || '- none found'}

Check:
1. Which model and provider really ran these jobs (read meta, events.jsonl, stderr.log, agent.sh for the kind).
2. Whether the Observatory's model, provider, class or price is wrong, and why (server.mjs scanJob/review, classify.mjs, data/classes.json, model_prices.json).
3. Whether the run itself did something wrong (wrong model used, fallback that should not have fired, cost leak).

Then FIX it ("just update them when they are wrong"; HARNESS.md §13):
- Wrong provider/class/price: add or correct a rule in classify.mjs ruleClass (before broader rules), or the
  price in data/classes.json; drop this key from data/jev-cache.json (keep model-rejects.json: it counts repeats).
- Wrong kind/model read from a job (a fallback run, an uncounted kind): fix the parse in server.mjs.
- Backup each file first into ${dir}/bak/; \`node --check\` every edited
  .mjs; then \`systemctl --user restart observatory\` and confirm via /api/snapshot that the item now shows
  the right provider/class (or is gone). If it is right after the fix, approve it with classify.mjs approve().
- Never edit agent.sh, the driver, index.html or anything outside _observatory/; if the run itself was wrong
  (bad fallback, cost leak), say so in the report and leave it for the watcher.
${loadRejectsHist(key) > 1 ? `- This item was sent back ${loadRejectsHist(key)} times: the earlier fix did not hold. Find why (which rule
  ran first, cache, parse) and make the fix structural, then add a line to _observatory/REVIEW-FIXES.md.
` : ''}
Write ${dir}/REPORT.md: first non-heading line = a one-sentence verdict for the owner (plain words, no names),
then what happened, evidence (file paths + lines), and what you changed (files + lines) or "approve as is".
Append one line to _observatory/REVIEW-FIXES.md: date, key, wrong -> right, files changed.
`);
  fs.writeFileSync(`${RUN}/audit_queue/${req}.req`, `model=opus\nprompt=${dir}/prompt.md\ndone=${dir}/claude.done\n`);
  const all = loadRejects(); all[key] = { at: Date.now(), dir, req, note: note || null, count: (all[key]?.count || 0) + 1 };
  fs.writeFileSync(REJECTS, JSON.stringify(all, null, 1));
  return all[key];
}
let scriptSig = '', agentShKinds = [], jevBusy = false;
function review() {
  // re-read agent.sh's kind list when agent.sh or worker.sh changes
  const sig = [AGENT_SH, WORKER_SH].map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join();
  if (sig !== scriptSig) { scriptSig = sig; agentShKinds = agentKinds(); }
  const approved = loadApproved();
  const items = new Map();
  for (const j of jobs.values()) {
    if (!j.kind) continue;
    const c = classify(j.kind, j.model);
    // jobs the server has no built-in handling for take the classifier's provider and class
    j.classified = c.provider ? c : null;
    // a kind with no built-in pricing whose source reported $0: estimate from model_prices.json
    j.estCost = j.classified && !CLASS[provOf(j)] && !j.cost && c.price && !/free|local/.test(c.class)
      ? (j.tokens.input * (c.price.input || 0) + j.tokens.cacheRead * (c.price.cached ?? c.price.input ?? 0)
        + j.tokens.cacheWrite * (c.price.write ?? c.price.input ?? 0) + j.tokens.output * (c.price.output || 0)) / 1e6 : 0;
    if (c.approved) continue;
    const it = items.get(c.key) || items.set(c.key, { ...c, kind: kindOf(j.kind), model: j.model || null, jobs: 0, active: 0, calls: 0, lastSeen: 0, sample: null }).get(c.key);
    it.provider = provOf(j) || it.provider;
    it.jobs += 1; it.active += j.active ? 1 : 0; it.calls += j.calls;
    it.lastSeen = Math.max(it.lastSeen, j.lastMsg || j.started || 0); it.sample = it.sample || `${j.project} · ${j.role} ${j.task}`;
    it.notes = j.notes; (it.dirs ||= []).push(j.dir);
  }
  // kinds added to agent.sh that have not run yet
  const approvedKinds = new Set(Object.values(approved).map((a) => a.kind));
  for (const k of agentShKinds) {
    if (approvedKinds.has(kindOf(k)) || [...items.values()].some((i) => i.kind === kindOf(k))) continue;
    const c = classify(k, null);
    if (!c.approved) items.set(c.key, { ...c, kind: kindOf(k), model: null, jobs: 0, active: 0, calls: 0, lastSeen: 0, sample: 'in agent.sh, not run yet' });
  }
  // Jev only for what the name rules can't place, one call at a time, answers cached per kind|model
  const ask = [...items.values()].find((i) => !i.rule && !i.jev);
  if (ask && !jevBusy) { jevBusy = true; askJev(ask.kind, ask.model, ask.notes || []).finally(() => { jevBusy = false; }); }
  const rej = loadRejects();
  // Jev is the first pass; when it is unsure (p < 0.5) an Opus review fixes the item, once per key
  for (const i of items.values()) if (i.source === 'jev' && (i.jev?.providerP ?? 1) < 0.5 && !rej[i.key]) { rej[i.key] = rejectItem(i.key, `auto: Jev unsure (provider p=${i.jev.providerP})`); }
  return [...items.values()].map(({ notes, dirs, ...i }) => ({ ...i, noUsage: i.jobs > 0 && i.calls === 0, rejected: rejectStatus(rej[i.key]) }))
    .sort((a, b) => b.active - a.active || b.lastSeen - a.lastSeen);
}

// ---------- Claude + Codex subscription sessions working under plans/ ----------
const claudeMsgs = new Map(); // message id -> { model, usage, session } (last line per id wins)
const claudeHeads = new Map(); // session id -> first 1200 chars of its opening prompt
const claudeStart = new Map(); // session id -> time of its opening prompt
const claudeCwd = new Map(); // session id -> cwd (plans path form)
const flat = (x) => Buffer.from(x).toString(); // a fresh copy, not a slice of a long line
function scanClaude(since) {
  const files = [];
  const walk = (dir, depth) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = `${dir}/${e.name}`;
      if (e.isDirectory() && depth < 3) walk(f, depth + 1);
      else if (e.name.endsWith('.jsonl')) { try { if (fs.statSync(f).mtimeMs >= since) files.push(f); } catch {} }
    }
  };
  walk(CLAUDE_PROJECTS, 0);
  walk(`${IMP_HOME}/.claude/projects`, 0);
  walk(CLAUDE_RUN_PROJECTS, 0);
  for (const f of files) for (const line of readNewLines(f)) {
    // the prompt that opened each session, to tie Haiku worker sessions to their jobs
    if (line.includes('"enqueue"')) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.sessionId && typeof o.content === 'string' && !claudeHeads.has(o.sessionId)) claudeHeads.set(flat(o.sessionId), flat(o.content.slice(0, 1200)));
      if (o.sessionId && !claudeStart.has(o.sessionId)) claudeStart.set(flat(o.sessionId), Date.parse(o.timestamp) || 0);
      continue;
    }
    // the folder each session ran in, to tie Sonnet orchestrator sessions to their project
    // (copy the matches: a regex match keeps its whole, often megabyte-long, line alive)
    const sid = line.match(/"sessionId":"([^"]+)"/)?.[1];
    if (sid && !claudeCwd.has(sid)) {
      const cwd = line.match(/"cwd":"([^"]+)"/)?.[1];
      if (cwd) claudeCwd.set(flat(sid), flat(toPlans(cwd)));
    }
    if (!line.includes('"usage"') || !(line.includes(`"cwd":"${PLANS}`) || line.includes(`"cwd":"${PLANS_REAL}`))) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const m = o.message;
    if (o.type !== 'assistant' || !m?.usage || !m.id || Date.parse(o.timestamp) < since) continue;
    claudeMsgs.set(m.id, { model: m.model || '', u: m.usage, session: o.sessionId, ts: Date.parse(o.timestamp) });
  }
}
// Jev (TypeSafe) classifier calls, logged by classify.mjs: charted as provider "jev", priced from the ledger
function scanJev() {
  for (const line of readNewLines(JEV_USAGE)) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = priceOf(o.model) || priceOf('jev-latest') || {};
    addRec(o.t, 'jev', o.model, o.input || 0, o.output || 0, 0, ((o.input || 0) * (p.input || 0) + (o.output || 0) * (p.output || 0)) / 1e6);
  }
}
// ElevenLabs calls logged by tools/eleven.mjs: provider "elevenlabs"; credits count as input units, $ from the plan rate
function scanEleven() {
  const r = elevenRates();
  for (const line of readNewLines(ELEVEN_USAGE)) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    addRec(o.t, 'elevenlabs', `${o.kind || 'tts'} · ${o.model || '?'}`, +o.credits || 0, 0, 0, Number.isFinite(+o.usd) ? +o.usd : (+o.credits || 0) * r.usdPerCredit);
  }
}
// per-model icons (model-icons.js): owner picks + the rule's saved icons for tiers seen for the first time
const MI = globalThis.ModelIcons;
// agy-bench.mjs is loaded fresh (cache-busted by mtime) so edits to it apply without a server restart
const agyBench = () => { const f = `${RUN}/bin/agy-bench.mjs`; let t = 0; try { t = fs.statSync(f).mtimeMs; } catch {} return import(`${f}?t=${t}`); };
const ICON_FILE = `${DATA}/model-icons.json`;
let iconStore = (() => { try { return Object.assign(MI.emptyStore(), JSON.parse(readText(ICON_FILE))); } catch { return MI.emptyStore(); } })();
function saveIcons() {
  fs.writeFileSync(`${ICON_FILE}.tmp`, JSON.stringify(iconStore, null, 2) + '\n');
  fs.renameSync(`${ICON_FILE}.tmp`, ICON_FILE);
}
// ledger keys of every model the run has used: price-check.mjs checks only these (data/run-models.json)
let runModels = new Set(), runModelsSig = '';
function saveRunModels() {
  const ids = new Set([...recs.values()].map((r) => r.model));
  for (const j of jobs.values()) if (j.model) ids.add(j.model);
  for (const m of claudeMsgs.values()) if (m.model) ids.add(m.model);
  for (const c of codexFiles.values()) if (c.cwd?.startsWith(PLANS)) for (const t of c.turns) ids.add(t.model);
  // the icon rule: first sight of a Claude/GPT tier the owner never picked saves its rule icon
  try { const r = MI.register([...ids].filter(Boolean), iconStore); if (r.changed) { iconStore = r.store; saveIcons(); } } catch (e) { console.error('model icons failed', e); }
  const keys = [...new Set([...ids].map((m) => priceOf(m)?.key).filter(Boolean))].sort();
  runModels = new Set(keys);
  if (keys.join() === runModelsSig) return;
  runModelsSig = keys.join();
  fs.writeFileSync(`${DATA}/run-models.json.tmp`, JSON.stringify({ at: new Date().toISOString(), models: keys }, null, 2) + '\n');
  fs.renameSync(`${DATA}/run-models.json.tmp`, `${DATA}/run-models.json`);
}
// price upkeep for the header chip and the review card (proposals only for models the run uses)
function prices() {
  let ledger = {}; try { ledger = JSON.parse(readText(LEDGER) || '{}'); } catch {}
  const st = loadState();
  return { ledgerUpdated: ledger.updated_at || null, staleDays: ledger.staleness_days || null, every: EVERY_DAYS,
    lastRun: st.lastRun || null, nextDue: st.nextDue || null, ok: st.ok ?? null, errors: st.errors || [],
    refreshed: st.refreshed || [], confirmed: st.confirmed || [], proposals: Object.values(loadProposals()).filter((p) => runModels.has(p.model)) };
}
// Headless Claude jobs: sum the Claude messages of the sessions that belong to the job.
// Haiku workers: the session's opening prompt is the job's prompt.md. Sonnet orchestrators (agent.sh sonnet):
// the same, plus the session ran in the job's project folder and started inside the job's run (the round
// template opens alike across plans). Queue jobs taken headless (headless-take.sh: Opus plan writers, premium
// audits and verifies): the preamble names the job's prompt file ("Follow this prompt file: <path>").
// CPU fix 2026-11-13: prompt.md heads cached per path; each job's matching sessions cached until claudeHeads grows
const promptHeads = new Map(), jobSids = new Map();
const promptHead = (f) => { if (!promptHeads.has(f)) { const h = readText(f).slice(0, 400).trimEnd(); if (!h) return h; promptHeads.set(f, h); } return promptHeads.get(f); };
function haikuUsage() {
  const bySession = new Map();
  for (const m of claudeMsgs.values()) (bySession.get(m.session) || bySession.set(m.session, []).get(m.session)).push(m);
  for (const j of jobs.values()) {
    const queued = !!j.claude && j.kind !== 'haiku' && j.kind !== 'sonnet';
    if (j.kind !== 'haiku' && j.kind !== 'sonnet' && !queued) continue;
    const head = j.kind === 'haiku' ? promptHead(`${path.dirname(j.dir)}/prompt.md`)
      : j.kind === 'sonnet' ? promptHead(`${j.dir}/prompt.md`) : '';
    const rel = path.relative(PLANS, toPlans(j.dir));
    if (!head && !queued) continue;
    const projDir = `${PLANS}/${rel.split('/')[0]}`;
    const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let cost = 0, calls = 0, last = null;
    const ck = `${j.dir}|${head.length}|${claudeHeads.size}`;
    let cached = jobSids.get(j.dir);
    if (!cached || cached.k !== ck) {
      const sids = [];
      for (const [sid, h] of claudeHeads) {
        if (queued) { const f = h.match(/Follow this prompt file: (\S+)/)?.[1]; if (!f || path.relative(PLANS, toPlans(path.dirname(f))) !== rel) continue; }
        else if (!h.startsWith(head.slice(0, 300))) continue;
        sids.push([sid, h]);
      }
      jobSids.set(j.dir, cached = { k: ck, sids });
    }
    for (const [sid, h] of cached.sids) {
      if (queued) { const f = h.match(/Follow this prompt file: (\S+)/)?.[1]; if (!f || path.relative(PLANS, toPlans(path.dirname(f))) !== rel) continue; }
      else if (!h.startsWith(head.slice(0, 300))) continue;
      if (j.kind === 'sonnet') {
        const st = claudeStart.get(sid) || 0;
        if (claudeCwd.get(sid) !== projDir || (j.started && st < j.started - 60e3) || (j.ended && st > j.ended)) continue;
      }
      for (const { model, u, ts } of bySession.get(sid) || []) {
        const p = claudePrice(model);
        const inp = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0, out = u.output_tokens || 0;
        t.input += inp; t.output += out; t.cacheRead += cr; t.cacheWrite += cw;
        cost += (inp * p.input + cr * p.cached + cw * p.write + out * p.output) / 1e6; calls += 1; last = Math.max(last || 0, ts);
      }
    }
    Object.assign(j, { tokens: t, cost, calls, lastMsg: last || j.lastMsg });
  }
}
const codexFiles = new Map(); // rollout file -> { cwd, model, prev, turns: [{ ts, model, input, cached, output, reasoning }] }
function scanCodex(since) {
  for (const root of [CODEX_SESSIONS, `${IMP_HOME}/.codex/sessions`]) for (let t = since - 86400e3; t <= Date.now() + 86400e3; t += 86400e3) {
    const d = new Date(t);
    const dir = `${root}/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    let names = []; try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) {
      const f = `${dir}/${n}`;
      try { if (fs.statSync(f).mtimeMs < since) continue; } catch { continue; }
      const c = codexFiles.get(f) || { cwd: null, prev: null, turns: [] };
      codexFiles.set(f, c);
      for (const line of readNewLines(f)) {
        if (c.cwd === null) { const x = line.match(/"cwd":"([^"]*)"/); if (x) c.cwd = flat(toPlans(x[1])); }
        if (!line.includes('"token_count"')) { const m = line.match(/"model":"(gpt-[^"]+)"/); if (m) c.model = flat(m[1]); continue; }
        let o; try { o = JSON.parse(line); } catch { continue; }
        const u = o.payload?.info?.total_token_usage; if (!u) continue;
        // totals are cumulative per session: keep the per-turn difference with its time
        const p = c.prev || {}; c.prev = u;
        const d = (k) => (u[k] || 0) - (p[k] || 0);
        const cached = d('cached_input_tokens');
        if (d('input_tokens') || d('output_tokens'))
          c.turns.push({ ts: Date.parse(o.timestamp), model: c.model || 'gpt-6.1-sol', input: d('input_tokens') - cached - d('cache_write_input_tokens'), cached,
            write: d('cache_write_input_tokens'), output: d('output_tokens'), reasoning: d('reasoning_output_tokens') });
      }
    }
  }
}

// rs: usage records already filtered by date and provider; f: the view filter (codex/claude by time and provider)
function valueSummary(rs, f) {
  const newSaved = () => ({ gross: 0, adjusted: 0, tokens: 0, models: [] });
  const saved = { free: newSaved(), local: newSaved(), antigravity: newSaved() }; // Antigravity: its own Free-layer card
  const go = { input: 0, output: 0, cacheRead: 0, calls: 0, apiEq: 0, off: f.excl.has('opencode-go') };
  const byModel = {};
  // OpenRouter card: paid models only (its free models count in the free-via-API savings)
  const or = { paidTokens: 0, paidCost: 0, paidCalls: 0, models: {}, off: f.excl.has('openrouter') };
  const el = { cost: 0, calls: 0, credits: 0, models: {}, off: f.excl.has('elevenlabs') }; // ElevenLabs card
  for (const r of rs) {
    const cls = recClass(r);
    if (r.provider === 'elevenlabs') { el.cost += r.cost; el.calls += r.calls; el.credits += r.input; const m = (el.models[r.model] ||= { model: r.model, credits: 0, cost: 0, calls: 0 }); m.credits += r.input; m.cost += r.cost; m.calls += r.calls; }
    if (r.provider === 'openrouter' && cls === 'paid-api') {
      const tok = r.input + r.output + r.cacheRead;
      or.paidTokens += tok; or.paidCost += r.cost; or.paidCalls += r.calls;
      const m = (or.models[r.model] ||= { model: r.model, tokens: 0, cost: 0, calls: 0 });
      m.tokens += tok; m.cost += r.cost; m.calls += r.calls;
    }
    if (cls === 'free' || cls === 'local') {
      const mn = cls === 'local' ? localName(r.provider, r.model) : r.model; // local rows by display name (qwen3.8 gets its own Strata entry)
      const m = (byModel[`${r.provider}|${mn}`] ||= { model: mn, provider: r.provider, cls, input: 0, output: 0, cacheRead: 0 });
      m.input += r.input; m.output += r.output; m.cacheRead += r.cacheRead;
    }
    if (r.provider === 'opencode-go' && cls !== 'free') { go.input += r.input; go.output += r.output; go.cacheRead += r.cacheRead; go.calls += r.calls; }
  }
  for (const m of Object.values(byModel)) {
    const ap = m.provider === 'antigravity' && agyPrice(m.model); // Antigravity: its own model's live price, no quality factor
    const gross = ap ? partCost(m, ap) : dsCost(m); const q = ap ? 1 : qualityOf(m.model); const tokens = m.input + m.output + m.cacheRead;
    const sv = m.provider === 'antigravity' ? saved.antigravity : saved[m.cls];
    sv.gross += gross; sv.adjusted += gross * q; sv.tokens += tokens;
    sv.models.push({ model: m.model, provider: m.provider, tokens, gross, q, ...(ap ? { rate: ap } : {}) });
  }
  for (const sv of Object.values(saved)) sv.models.sort((a, b) => b.tokens - a.tokens);
  saved.antigravity.rates = { at: AGY_P.at || null, models: AGY_P.models || {} };
  go.apiEq = dsCost(go);
  go.tokens = go.input + go.output + go.cacheRead;

  const codex = { sessions: 0, input: 0, cached: 0, write: 0, output: 0, reasoning: 0, apiEq: 0, off: f.excl.has('codex') };
  if (!codex.off) for (const c of codexFiles.values()) {
    if (!c.cwd?.startsWith(PLANS)) continue;
    const turns = c.turns.filter((t) => f.inRange(t.ts));
    if (!turns.length) continue;
    codex.sessions += 1;
    for (const t of turns) { codex.input += t.input; codex.cached += t.cached; codex.write += t.write || 0; codex.output += t.output; codex.reasoning += t.reasoning; codex.apiEq += codexCost(t, t.model); }
  }
  // + Codex subscription usage through Pi (the only Codex records in rs)
  for (const r of rs) if (r.provider === 'codex') { codex.input += r.input; codex.cached += r.cacheRead; codex.write += r.cacheWrite || 0; codex.output += r.output; codex.apiEq += r.cost; }
  codex.tokens = codex.input + codex.cached + codex.output;

  const claude = { sessions: 0, input: 0, cached: 0, cacheWrite: 0, output: 0, apiEq: 0, off: f.excl.has('anthropic') };
  const sessions = new Set();
  if (!claude.off) for (const { model, u, session, ts } of claudeMsgs.values()) {
    if (!f.inRange(ts)) continue;
    const p = claudePrice(model);
    const inp = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0, out = u.output_tokens || 0;
    claude.input += inp; claude.cached += cr; claude.cacheWrite += cw; claude.output += out;
    claude.apiEq += (inp * p.input + cr * p.cached + cw * p.write + out * p.output) / 1e6;
    sessions.add(session);
  }
  claude.sessions = sessions.size;
  claude.tokens = claude.input + claude.cached + claude.cacheWrite + claude.output;
  or.models = Object.values(or.models).sort((a, b) => b.cost - a.cost);
  el.models = Object.values(el.models).sort((a, b) => b.cost - a.cost);
  return { saved, go, codex, claude, or, el };
}

// ---------- OpenCode Zen (free tier, official CLI) ----------
const zenSeen = new Map(); // db -> max message time_created already counted
function scanZen() {
  for (const f of [OPENCODE_DB, `${IMP_HOME}/.local/share/opencode/opencode.db`]) scanZenDb(f);
}
function scanZenDb(file) {
  if (!exists(file)) return;
  let db;
  try { db = new DatabaseSync(file, { readOnly: true }); } catch { return; }
  try {
    const rows = db.prepare(`select s.directory dir, m.time_created t, m.data data from message m join session s on s.id = m.session_id
      where m.time_created > ? and (s.directory like ? or s.directory like ?) order by m.time_created`).all(zenSeen.get(file) || 0, `${PLANS}/%`, `${PLANS_REAL}/%`);
    for (const r of rows) {
      zenSeen.set(file, Math.max(zenSeen.get(file) || 0, r.t));
      let d; try { d = JSON.parse(r.data); } catch { continue; }
      if (d.role !== 'assistant') continue;
      const project = path.relative(PLANS, toPlans(r.dir)).split('/')[0];
      const tk = d.tokens || {};
      const out = (tk.output || 0) + (tk.reasoning || 0); // OpenCode counts reasoning apart from output
      const tok = (tk.input || 0) + out + (tk.cache?.read || 0) + (tk.cache?.write || 0);
      // attribute to the zen job of that project running at that time
      const cands = [...jobs.values()].filter((x) => x.project === project && x.kind && x.kind.startsWith('zen:')
        && x.started && r.t >= x.started - 60000 && (!x.ended || r.t <= x.ended + 60000));
      const j = cands.find((x) => x.kind === `zen:${d.modelID}`) || cands[0];
      if (j) account(j, 'opencode', d.modelID, tk.input || 0, out, tk.cache?.read || 0, d.cost || 0, r.t, tok, tk.cache?.write || 0, tk.reasoning || 0);
      else addRec(r.t, 'opencode', d.modelID, tk.input || 0, out, tk.cache?.read || 0, d.cost || 0, tk.cache?.write || 0, tk.reasoning || 0);
    }
  } catch {} finally { db.close(); }
}

// ---------- projects, tasks, run state ----------
const STAGES = ['p1', 'v1-r1', 'v1-r2', 'v1-r3', 'focus', 'v2-r1', 'v2-r2', 'v2-r3', 'verify', 'done'];

// auditEstimate: see audit-estimate.mjs (shared with _run/bin/audit-bump.mjs)

// A reopened project (driver.mjs reopen, revision 3+) runs vN-focus, vN-r1..3, vN-verify. Those map onto
// the focus, 2.r1-2.r3 and verify columns; the columns before them show the earlier finished run.
function colOf(stage) {
  if (STAGES.includes(stage)) return STAGES.indexOf(stage);
  const m = /^v\d+-(focus|setup|gate|verify|r([123]))$/.exec(stage || '');
  return !m ? -1 : m[1] === 'focus' || m[1] === 'setup' ? 4 : m[1] === 'gate' ? 6 : m[1] === 'verify' ? 8 : 4 + Number(m[2]);
}
const colNames = (n) => STAGES.map((x, i) => (i === 4 ? `v${n}-focus` : i >= 5 && i <= 7 ? `v${n}-r${i - 4}` : i === 8 ? `v${n}-verify` : x));
// active build (HARNESS §12 item 11): setup, one round, the owner's audit gate, verify; column 7 is unused ('')
const activeCols = (n) => STAGES.map((x, i) => (i === 4 ? `v${n}-setup` : i === 5 ? `v${n}-r1` : i === 6 ? `v${n}-gate` : i === 7 ? '' : i === 8 ? `v${n}-verify` : x));

// Plan areas and their colors, shared with the hub generator (_run/bin/hub.mjs).
function categories() {
  try { return JSON.parse(readText(`${PLANS}/categories.json`)); } catch { return { colors: {}, plans: {} }; }
}
// Whole-category pause (owner 2026-11-10, "pause all game plans"): the HOLD logic lives in the harness,
// _run/bin/category-hold.mjs (pause/resume/status); AgentGlim only calls it, never writes HOLDs for a category itself.
// Re-imported when the file changes, so a harness edit needs no AgentGlim restart. null when the harness has no such module.
const CAT_HOLD = `${RUN}/bin/category-hold.mjs`, CAT_OPTS = { plansDir: PLANS, runDir: RUN };
async function categoryHold() {
  let st; try { st = fs.statSync(CAT_HOLD); } catch { return null; }
  return import(`${pathToFileURL(CAT_HOLD).href}?v=${Math.round(st.mtimeMs)}`);
}

// The Observatory's own row: it is not a plan, so it shows server health instead of stages.
const SELF_STARTED = Date.now();
function selfStatus() {
  const files = ['server.mjs', 'index.html', 'classify.mjs', 'price-check.mjs', 'model-icons.js'];
  let last = null;
  for (const f of files) {
    try { const t = fs.statSync(`${HERE}/${f}`).mtimeMs; if (!last || t > last.at) last = { file: f, at: t }; } catch {}
  }
  let codeAt = 0;
  try { codeAt = fs.statSync(`${HERE}/server.mjs`).mtimeMs; } catch {}
  // server.mjs changed after this process started: the running server is older than the file
  return { pid: process.pid, started: SELF_STARTED, last, restartNeeded: codeAt > SELF_STARTED, cat: categories().plans.observatory || 'Ops' };
}

// Report the configured feature-loop plan's latest feature audits separately from final verification.
function featureAudit() {
  if (!integrations.remotePlan) return null;
  const root = `${PLANS}/${integrations.remotePlan}`, b = `${root}/_build`;
  let items; try { items = JSON.parse(readText(`${b}/subitems.json`)).items; } catch { return null; }
  if (!items?.length || items.some((i) => i.status !== 'done')) return null;
  const scores = [];
  for (const item of items) {
    const dir = path.dirname(`${root}/${item.brief}`);
    let rounds; try { rounds = fs.readdirSync(dir).filter((n) => /^r\d+$/.test(n)).sort((a, b) => +b.slice(1) - +a.slice(1)); } catch { return null; }
    const score = auditEstimate(readText(`${dir}/${rounds[0]}/AUDIT.md`));
    if (!score) return null;
    scores.push(score.pct);
  }
  return { pct: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length), round: `feature audit mean (${scores.length})`, text: `Mean of latest independent feature audit scores: ${scores.join(', ')}%. Historical final verification remains separate; this is not a fresh consolidated requirement pass rate.` };
}

// CPU fix 2026-11-13: AUDIT.md estimates cached by file size and mtime (read for every plan and round each scan)
const auditMemo = new Map();
function auditEstimateOf(f) {
  let st; try { st = fs.statSync(f); } catch { return auditEstimate(''); }
  const k = `${st.size}:${st.mtimeMs}`, m = auditMemo.get(f);
  if (m && m.k === k) return m.e && { ...m.e };
  const e = auditEstimate(readText(f)); auditMemo.set(f, { k, e }); return e && { ...e };
}
function projects(state) {
  const out = [];
  const cats = categories(), folds = foldNotes(PLANS), kids = {};
  const jobsBy = Map.groupBy(jobs.values(), (j) => j.project); // CPU fix 2026-11-13: one pass, not one per plan and task
  for (const [c, f] of Object.entries(folds)) (kids[f.parent] ||= []).push(c);
  // every plan folder with a PLAN.md is a project: new plans (70, 71) have no driver state until their
  // first round, and used to be missing from the board altogether
  const all = { ...Object.fromEntries(planDirs(PLANS).map((d) => [d, { stage: '', stages: [], noState: true }])), ...(state.projects || {}) };
  for (const [dir, p] of Object.entries(all)) {
    if (!/^\d\d-[a-z0-9-]+$/.test(dir) || !fs.existsSync(path.join(PLANS, dir))) continue;
    const b = `${PLANS}/${dir}/_build`;
    const round = /^v\d+-r\d$/.test(p.stage) ? p.stage : null;
    let tasks = [];
    if (round) {
      let names = [];
      try { names = fs.readdirSync(`${b}/${round}/tasks`).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)); } catch {}
      tasks = names.map((t) => {
        const w = `${b}/${round}/workers/${t}`;
        const wj = (jobsBy.get(dir) || []).filter((j) => j.step === round && j.task === t);
        const live = wj.find((j) => j.active);
        const status = exists(`${w}/DONE`) ? 'done' : live ? 'running' : wj.some((j) => j.rc && j.rc !== '0') ? 'retry' : 'queued';
        return { name: t, status, model: (live || wj.at(-1))?.model || null, slot: (live || wj.at(-1))?.slot || null };
      });
    }
    let progress = null;
    const revRounds = [];
    for (let n = p.rev?.n || 0; n >= 3; n--) revRounds.push(`v${n}-r3`, `v${n}-r2`, `v${n}-r1`);
    for (const r of [...revRounds, 'v2-r3', 'v2-r2', 'v2-r1', 'v1-r3', 'v1-r2', 'v1-r1']) {
      const e = auditEstimateOf(`${b}/${r}/AUDIT.md`);
      if (e) { progress = { round: r, ...e }; break; }
    }
    if (progress && !progress.word) { try { progress.word = auditSays(readText(`${b}/${progress.round}/AUDIT.md`))?.word || null; } catch {} } // PASS / PARTIAL / FAIL of the last audit
    if (dir === integrations.remotePlan && !progress) progress = featureAudit();
    // no round audits (plans built outside the driver, e.g. onboarded 72-82): the final verify pass rate (2026-11-12)
    if (!progress && p.stage === 'done') { const vt = readText(`${b}/VERIFY.md`), pct = verifyRate(vt); if (pct != null) progress = { round: 'verify', pct, text: (vt.split('\n').find((l) => l.trim()) || '').replace(/[*_`]/g, '').slice(0, 200), word: pct >= 90 ? 'PASS' : 'PARTIAL' }; }
    const pj = jobsBy.get(dir) || [];
    const tracked = trackedNow().plans.get(dir) || [];
    const trackedLive = tracked.filter((j) => j.status === 'running' && j.kind !== 'autonomous').length; // autonomous ones are driver jobs, counted below
    const act = exists(`${PLANS}/${dir}/ACTIVE`) && (p.stages || []).some((x) => /-gate$/.test(x));
    const rev = p.rev ? { n: p.rev.n, label: p.rev.label, at: p.rev.at, prevDone: p.rev.prevDone, cols: act ? activeCols(p.rev.n) : colNames(p.rev.n) } : null;
    const activeBuild = act ? { note: readText(`${PLANS}/${dir}/ACTIVE`).trim().slice(0, 300), gateAt: /-gate$/.test(p.stage) && !exists(`${PLANS}/${dir}/HOLD`) ? p.gateAt || null: null }: null; // a HOLD plan is not waiting for an audit (plan 03 is audited by hand)
    // live driver work outside an ACTIVE build (2026-11-12): a plan in a driver stage (not done, not on hold) or with a live job is
    // listed in Active builds too, with its current stage and the models running on it (it used to fall back to the Pipeline table only)
    const liveModels = [...new Set([...pj.filter((j) => j.active).map((j) => j.model), ...tracked.filter((j) => j.status === 'running' && j.kind !== 'autonomous').map((j) => j.model)].filter(Boolean))];
    const liveStage = p.stage && !['done', 'skipped'].includes(p.stage) && !p.noState && !exists(`${PLANS}/${dir}/HOLD`);
    const liveBuild = !act && (liveStage || liveModels.length || trackedLive) ? { stage: p.stage, models: liveModels, running: pj.some((j) => j.active) || trackedLive > 0 } : null;
    // headless /goal agent on this plan (_run/bin/goal.sh): state.json plus the checklist in PROGRESS.md
    const goal = (() => { try { const g = JSON.parse(readText(`${PLANS}/${dir}/_goal/state.json`));
      const pl = readText(`${PLANS}/${dir}/_goal/PROGRESS.md`).split('\n').filter((l) => /^\s*[-*|]/.test(l));
      g.items = pl.length; g.itemsDone = pl.filter((l) => /\b(done|fixed|deferred)\b|\[x\]/i.test(l)).length;
      // state.json still says running after a kill: check the agent's process group
      if (process.platform !== 'win32' && ['starting', 'running'].includes(g.status) && g.pgid) { try { process.kill(-g.pgid, 0); } catch { g.status = 'stopped'; g.ended = g.ended || g.updated; } }
      // a goal agent that ended over 24 h ago is history; the plan's own pipeline took over, so no goal icon
      if (!['starting', 'running', 'paused', 'limit'].includes(g.status) && Date.now() - (g.ended || g.updated || 0) > 24 * 3600e3) return null;
      return g; } catch { return null; } })();
    // owner/goal HOLD (driver starts nothing new) and the 15 min wait after a usage-limit pause
    const approved = exists(`${PLANS}/${dir}/OWNER-APPROVED`) ? (readText(`${PLANS}/${dir}/OWNER-APPROVED`).trim().split('\n')[0] || 'approved').slice(0, 200): null; // owner sign-off: hidden unless the approved filter is on
    const held = exists(`${PLANS}/${dir}/HOLD`) ? (readText(`${PLANS}/${dir}/HOLD`).trim().split('\n')[0] || 'on hold').slice(0, 200) : null;
    // auto-complete (HARNESS 1.5): latest verify/audit >= 90%, the driver stops auto reopens; not human-verified
    const autoComplete = exists(`${PLANS}/${dir}/AUTO_COMPLETE`) ? (readText(`${PLANS}/${dir}/AUTO_COMPLETE`).trim().split('\n')[0] || 'auto-complete (not human-verified)').slice(0, 200) : null;
    // end states (HARNESS 1.5): two only. owner-verified = NN-slug/OWNER-APPROVED (the owner signed off);
    // auto-complete = agents finished it (pipeline done, or AUTO_COMPLETE at >= 90%) with no owner sign-off. "done" is not shown.
    const endState = approved ? 'owner-verified' : (autoComplete || p.stage === 'done') ? 'auto-complete' : null;
    const cooldownUntil = (p.cooldownUntil || 0) > Date.now() ? p.cooldownUntil : null;
    // sub-item rows on the pipeline: <plan>/_build/subitems.json {items:[{id,title,status,pct,note,updated}]}
    const sub = (() => { try { return displayLiveStatus(JSON.parse(readText(`${b}/subitems.json`)).items || [], dir, tracked); } catch { return null; } })();
    // agent on the active sub-item build (feature-loop.sh loop-state.json)
    try { const ls = JSON.parse(readText(`${b}/features/loop-state.json`)); const num = String(ls.feature || '').split('-')[0];
      if (sub && num && ['running', 'waiting_usage', 'paused'].includes(ls.status)) { const it = sub.find((x) => String(x.id) === num && x.status === 'running'); if (it) it.agent = { step: ls.step, round: ls.round, model: ls.model, effort: ls.effort, since: ls.stepStarted, status: ls.status }; } } catch {}
    // Bounded owner runs have display stages separate from driver scheduling state.
    let displayStage = p.stage;
    try {
      const br = JSON.parse(readText(`${b}/bounded-run.json`));
      const base = `${b}/${br.directory}`;
      const sol = Number(readText(`${base}/sol/pid`).trim());
      const luna = Number(readText(`${base}/luna/pid`).trim());
      if (!exists(`${base}/FINISHED.json`) && ((sol && alive(sol)) || (luna && alive(luna)))) {
        displayStage = luna && alive(luna) ? 'v2-r2' : 'v2-r1';
      }
    } catch {}
    const proj = { dir, title: planTitle(PLANS, dir), foldedInto: folds[dir]?.parent || null, merged: kids[dir] || [], noState: !!p.noState, sub, tracked, features: featuresOf(dir), stage: displayStage, stageIndex: colOf(displayStage), attempts: p.attempts, round, held, approved, autoComplete, endState, cooldownUntil, tasks, progress, rev, activeBuild, liveBuild, goal, cat: planCategory(dir, cats, folds, planTitle(PLANS, dir)),
      tokens: pj.reduce((n, j) => n + j.tokens.input + j.tokens.output + j.tokens.cacheRead, 0),
      cost: pj.reduce((n, j) => n + j.cost, 0), active: pj.filter((j) => j.active).length + trackedLive + (manualSessions.get(dir) || []).length + (goal && ['starting', 'running', 'paused'].includes(goal?.status) ? 1 : 0),
      // models of the plan's most recent step (icons on 03 sub-rows whose plan is idle)
      lastModels: (() => { const at = (j) => j.ended || j.started || 0, last = pj.reduce((x, y) => (!x || at(y) > at(x) ? y : x), null), seen = new Set();
        return last ? pj.filter((j) => j.step === last.step && !seen.has(provOf(j) + j.model) && seen.add(provOf(j) + j.model)).map((j) => ({ step: j.step, role: j.role, provider: provOf(j), model: j.model })) : []; })(),
      working: (() => {
        // an orchestrator whose only other live job is a paused audit/verify is blocked inside audit.sh: show it paused too
        const live = pj.filter((j) => j.active), others = live.filter((j) => j.role !== 'orchestrator');
        const orchBlocked = others.length > 0 && others.every((j) => j.waiting || j.stopped);
        return [...live.map((j) => ({ provider: provOf(j), role: j.role, task: j.task, model: j.model, stopped: !!j.stopped,
          paused: !!j.waiting || !!j.stopped || (j.role === 'orchestrator' && orchBlocked) })),
          ...(manualSessions.get(dir) || []).map(manualWork),
          ...(goal && ['starting', 'running', 'paused'].includes(goal.status) ? [{ provider: 'claude', role: 'goal', task: '/goal agent (_goal/PROGRESS.md)', model: goal.model, paused: goal.status === 'paused' }] : [])];
      })() };
    proj.section = sectionOf(proj); // Active builds or Pipeline, never both (sections.mjs)
    out.push(proj);
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

// The Observatory's own row in the Active builds table: its updates are tracked like an
// active build. data/updates.json lists them ({ id, title, status: building|review|verify|done, at, doneAt });
// the oldest open one sets the stage. Tokens: Claude and Codex sessions that ran inside _observatory/.
const UPDATE_STAGES = ['building', 'review', 'verify', 'done'];
// hourly status digest: the watcher's "status?" answer as data for the Status card above
// Active builds; rebuilt once an hour from the scan, cached in data/status-digest.json so a restart keeps it
const DIGEST_FILE = `${DATA}/status-digest.json`, DIGEST_MS = 15e3; // 10 min (was hourly) + POST /api/status-refresh
const ASK_DIR = `${RUN}/status_ask`; // "refresh now" status asks to the watcher: <ms>.json pending,.json.answered once status-write.mjs ran with words
function statusAsk() { try { const f = fs.readdirSync(ASK_DIR).filter((x) => /^\d+\.json(\.answered)?$/.test(x)).sort((a, b) => parseInt(b) - parseInt(a))[0]; if (!f) return null; let j = {}; try { j = JSON.parse(readText(`${ASK_DIR}/${f}`)); } catch {} return { id: parseInt(f), at: parseInt(f), state: f.endsWith('.answered') ? 'answered' : 'pending', answeredAt: j.answeredAt ? Date.parse(j.answeredAt) : null }; } catch { return null; } }
let digestCache = null;
// a status_ask with no answer within 5 min is answered by the server itself (status-write.mjs --auto)
const ASK_AUTO_MS = 5 * 60e3; let askAutoBusy = false;
function askAutoAnswer() {
  if (askAutoBusy) return;
  let old = []; try { old = fs.readdirSync(ASK_DIR).filter((x) => /^\d+\.json$/.test(x) && Date.now() - parseInt(x) > ASK_AUTO_MS); } catch { return; }
  if (!old.length || !has(`${RUN}/bin/status-write.mjs`)) return;
  askAutoBusy = true;
  execFile(process.execPath, [`${RUN}/bin/status-write.mjs`, '--auto'], { timeout: 180e3 }, (err) => { askAutoBusy = false; console.log(`status ask auto-answer (${old.join(', ')}): ${err ? 'failed ' + err.message : 'answered as auto'}`); });
}
if (!DEV) setInterval(askAutoAnswer, 60e3);
const reapJobs = makeReaper(has(`${RUN}/bin/jobs-track.py`) ? `${RUN}/bin/jobs-track.py` : `${HERE}/../tools/addons/jobs-track.py`, TJ_DIR);
if (!DEV) { setInterval(reapJobs, 20e3); setTimeout(reapJobs, 3e3); }
function stagePlain(st, rounds) {
  let m;
  if (!st) return 'not started';
  if (st === 'done') return 'done';
  if (st === 'p1') return 'writing the plan';
  if ((m = /^v(\d+)-r(\d)$/.exec(st))) return `build round ${m[2]} of ${rounds} (v0.${m[1] - 1})`;
  if (/focus$/.test(st)) return 'choosing what the next revision fixes';
  if (/setup$/.test(st)) return 'setting up the build';
  if (/gate$/.test(st)) return 'waiting for your audit';
  if (/verify$/.test(st)) return 'final verify';
  return st;
}
// what the watcher's status answer says beyond the stage rows: the audit's verdict and
// biggest risk, this round's workers and the orchestrator's last note, the health checks from watch.sh, and
// the watcher's own done/running/blocked/next lines (data/status.json, written by bin/status-write.mjs)
function auditSays(md, fallback) { // fallback: the audit's progress sentence, when it has no one-line verdict
  if (!md) return null;
  const clean = (x) => Buffer.from(x.replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim()).toString();
  const cut = (x, n) => x.length <= n ? x : x.slice(0, n).replace(/\s+\S*$/, '') + '…'; // end on a whole word
  let v = /\*\*Verdict:?\s*([^]*?)\*\*/i.exec(md) || /^#+\s*Verdict[^\n]*\n+([^\n]+)/im.exec(md) || /\bVerdict:\s*([^\n|]+)/i.exec(md);
  if (v && /^\s*\|/.test(v[1])) v = null; // a "Verdict per task" table, not a one-liner
  const r = /biggest risks?[^\n:]*:\**\s*([^\n]+)/i.exec(md);
  const vt = v ? clean(v[1]) : '', w = /^\W*(PASS|PARTIAL|FAIL|GREEN|RED|AMBER|OK|BLOCKED|INCOMPLETE)\b/i.exec(vt);
  return { word: w ? w[1].toUpperCase() : null, verdict: cut(vt || (fallback ? clean(fallback) : ''), 260) || null, risk: r ? cut(clean(r[1]), 260) : null };
}
function roundNotes(dir, stage) {
  const b = `${PLANS}/${dir}/_build/${stage}`, out = { workers: [], orch: null, newest: 0 };
  if (!stage || !exists(b)) return out;
  try { for (const w of fs.readdirSync(`${b}/workers`)) out.workers.push({ name: w, state: exists(`${b}/workers/${w}/DONE`) ? 'done' : 'running' }); } catch {}
  const last = readText(`${b}/orch/last.txt`).split('\n').find((l) => l.trim() && l.trim() !== 'ROUND_DONE');
  if (last) out.orch = Buffer.from(last.replace(/\*\*|`/g, '').trim().slice(0, 240)).toString();
  // newest write under the step folder (bounded walk): watch.sh's stall check, on the step's own files
  let n = 0; const walk = (d, depth) => { if (n > 3000 || depth > 4) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { n++; const f = `${d}/${e.name}`; if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f, depth + 1); } else { try { const t = fs.statSync(f).mtimeMs; if (t > out.newest) out.newest = t; } catch {} } } };
  try { walk(b, 0); } catch {}
  return out;
}
function healthNow(base) {
  const now = Date.now(), H = 3600e3, fl = base.flags || {}, out = {};
  const models = readText(`${RUN}/flags/zen_free_models`).split(/\s+/).filter((x) => x && !x.startsWith('#'));
  const pz = (m) => !!(fl[`zen_model_${m}_paused`] && now - fl[`zen_model_${m}_paused`] < H); // paused = 429 within the hour
  out.free = { total: models.length, paused: models.filter(pz).length, list: models.map((m) => ({ m, paused: pz(m) })) };
  const kills = readText(`${RUN}/flags/hang-reaper.log`).trim().split('\n').filter(Boolean).slice(-200).filter((l) => now - Date.parse(l.slice(0, 19).replace(' ', 'T')) < 24 * H);
  try { const w = JSON.parse(readText(`${RUN}/flags/watchdog/current.json`)); out.watchdog = { at: w.at, findings: (w.findings || []).slice(0, 12) }; } catch {} // watchdog card
  out.hangs = { n: kills.length, last: kills.length ? Buffer.from(kills.at(-1).slice(20, 160)).toString() : null };
  let q = []; try { q = fs.readdirSync(`${RUN}/audit_queue`).filter((x) => x.endsWith('.req')).map((x) => exists(`${RUN}/audit_queue/${x.slice(0, -4)}.taken`)); } catch {}
  out.queue = { pending: q.filter((t) => !t).length, taken: q.filter((t) => t).length, armed: auditqArmed };
  try { const mi = readMemoryInfo(); out.mem = { usedPct: Math.round(100 - mi.MemAvailable / mi.MemTotal * 100), availGb: +(mi.MemAvailable / 2 ** 30).toFixed(1) }; } catch {}
  try { const st = fs.statfsSync(os.tmpdir()); out.tmp = { usedPct: Math.round(100 - st.bavail / st.blocks * 100), freeGb: +(st.bavail * st.bsize / 2 ** 30).toFixed(1) }; } catch {}
  return out;
}
function watcherSaid() {
  try { const j = JSON.parse(readText(`${DATA}/status.json`)); return j.lines ? { at: Date.parse(j.linesAt || j.at), source: j.source, lines: j.lines } : null; } catch { return null; }
}
function featureList() {
  const dir = integrations.auditPlan;
  if (!dir) return null;
  const F = `${PLANS}/${dir}/_build`; let items = [], loop = null;
  try { items = displayLiveStatus(JSON.parse(readText(`${F}/subitems.json`)).items, integrations.auditPlan, trackedNow().plans.get(integrations.auditPlan) || []).filter((i) => i.kind === 'feature').map((i) => ({ id: i.id, title: i.title, status: i.status, statusHint: i.statusHint, updated: i.updated, pct: i.pct ?? null, note: (i.note || '').slice(0, 140) })); } catch {}
  try { const l = JSON.parse(readText(`${F}/features/loop-state.json`)); const display = displayLiveStatus([{ ...l, updated: l.updated || l.stepStarted }], integrations.auditPlan, trackedNow().plans.get(integrations.auditPlan) || [])[0]; loop = { status: display.status, statusHint: display.statusHint, live: !!l.pgid && alive(l.pgid), feature: l.feature || '', round: l.round, step: l.step || '', model: l.model, stepStarted: l.stepStarted || null }; } catch {}
  return items.length || loop ? { items, loop } : null;
}
// per-plan extras for the plan view: audit % per round, minutes per step, the plan's one-liner
// VERIFY.md "N pass / M partial / K fail" totals -> pass rate % (plan 55 shows 30/33 = 91%)
function verifyRate(v) {
  const m = /(\d+) pass(?:es)?\s*\/\s*(\d+) partial\s*\/\s*(\d+) fail/i.exec(v || ''); if (!m) return verifyTableRate(v);
  const n = +(/\(?(?:of )?(\d+) requirements/i.exec(v.slice(m.index, m.index + 200))?.[1] || 0) || (+m[1] + +m[2] + +m[3]);
  return n ? Math.round(100 * m[1] / n) : null;
}
// no totals line (onboarded plans 72-82 write "13/13 pass, 0 partial, 0 fail" and a requirement table): pass rows / all
// status rows of the requirement table, the same rule as the harness (_run/bin/reopen-guards.mjs passRate) (2026-11-12)
function verifyTableRate(v) {
  let pass = 0, all = 0;
  for (const line of String(v || '').split('\n')) {
    if (!/^\s*\|/.test(line) || /^\s*\|\s*-/.test(line)) continue;
    const c = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((x) => x.trim());
    if (c.length < 3) continue;
    const st = [2, 3, 1].map((k) => /^\**\s*(pass|partial|fail)/i.exec((c[k] || '').replace(/`/g, ''))?.[1]).find(Boolean);
    if (!st) continue;
    all++; if (st.toLowerCase() === 'pass') pass++;
  }
  return all ? Math.round(100 * pass / all) : null;
}
function planExtras(dir, stages, hist) {
  const b = `${PLANS}/${dir}/_build`, auditHist = [];
  let rounds = []; try { rounds = fs.readdirSync(b).filter((n) => /^v\d+-r\d$/.test(n)).sort((x, y) => (+x.slice(1).split('-r')[0] - +y.slice(1).split('-r')[0]) || x.localeCompare(y)); } catch {} // every round ever, not just this revision's columns
  for (const st of rounds) { const x = auditEstimate(readText(`${b}/${st}/AUDIT.md`)); if (x) auditHist.push({ round: st, pct: x.pct }); }
  if (!rounds.length && exists(`${b}/features`)) { // feature-loop plans (e.g. 55): show the final verify pass rate
    const pct = verifyRate(readText(`${b}/VERIFY.md`)); if (pct != null) auditHist.push({ round: 'verify', pct });
    if (dir === integrations.remotePlan) { const feature = featureAudit(); if (feature) auditHist.push({ round: feature.round, pct: feature.pct }); }
  }
  const steps = [], h = (hist || []).filter((x) => x.at), tk = {};
  for (const j of jobs.values()) if (j.project === dir && j.step) { const t = (tk[j.step] ||= { tok: 0, cost: 0, atok: 0, acost: 0 }), n = (j.tokens.input || 0) + (j.tokens.output || 0) + (j.tokens.cacheRead || 0) + (j.tokens.cacheWrite || 0), au = /^(auditor|verifier)$/.test(j.role); /* focus check is planning, not an audit (fix 10) */ if (au) { t.atok += n; t.acost += j.cost || 0; } else { t.tok += n; t.cost += j.cost || 0; } } // audit jobs apart from working jobs  // tokens per step (find wasted tokens)
  for (let i = 1; i < h.length; i++) { const m = Math.round((Date.parse(h[i].at) - Date.parse(h[i - 1].at)) / 60e3); if (m >= 0 && m < 3 * 1440 && h[i].step !== 'reopen') { const t = tk[h[i].step] || {}; steps.push({ step: h[i].step, mins: m, tok: t.tok || 0, cost: +(t.cost || 0).toFixed(2), atok: t.atok || 0, acost: +(t.acost || 0).toFixed(2) }); } }
  let about = ''; const md = readText(`${PLANS}/${dir}/PLAN.md`).slice(0, 6000);
  const prob = /^##\s*Problem[^\n]*\n+([^\n]+)/im.exec(md) || /^#[^\n]*\n+(?:[^\n]*\n)*?\n([^#\n][^\n]+)/m.exec(md);
  if (prob) about = Buffer.from(prob[1].replace(/\*\*|`/g, '').trim().slice(0, 300).replace(/\s+\S*$/, '')).toString();
  return { auditHist, steps: steps.slice(-12), about };
}
const MODES_MJS = `${RUN}/bin/modes.mjs`;
// Link the shipped SuperAgent tools into the run folder (same step as `npm run scaffold-harness`). Issue #1.
const runScaffold = (cb) => execFile(process.execPath, [path.join(HERE, '..', 'tools', 'scaffold-harness.mjs')], { timeout: 20000, maxBuffer: 1 << 20, env: process.env }, (err, so, se) => cb({ ok: !err, output: (String(so || '') + String(se || '')).trim().slice(0, 4000) }));
const modesRun = (args, cb) => execFile(process.execPath, [MODES_MJS, ...args], { timeout: 15000, maxBuffer: 1 << 20 }, (err, so, se) => cb(err, String(so || ''), String(se || '')));
const modeRequest = (key, value, until, cb) => modesRun(['request', key, value, ...(until ? ['--until', until] : []), '--by', 'status card'], (err, so, se) => cb(err ? (err.code === 2 ? 422 : 500) : 200, (so || se).trim()));
function speedNow(base) { // per subscription: router step, slots that can start, agents running
  let cfg = {}, b = {}; try { cfg = JSON.parse(readText(`${RUN}/config.json`)); } catch {} try { b = JSON.parse(readText(BUDGET_FILE)); } catch {} // providers[].step/pace/slots
  const running = {}; for (const p of base.projects || []) for (const w of p.working || []) { const k = w.provider === 'opencode-go' ? (/go2|g2/.test(w.task || '') ? 'go2' : 'go') : w.provider === 'anthropic' || w.provider === 'claude' ? 'claude' : w.provider; running[k] = (running[k] || 0) + 1; }
  const prov = b.providers || {}, out = [];
  for (const id of ['claude', 'codex', 'go', 'go2']) { const p = prov[id] || {}; out.push({ id, name: { claude: 'Claude', codex: 'Codex', go: 'OpenCode Go', go2: 'OpenCode Go 2' }[id], step: p.step ?? null, pace: p.pace || null, limited: !!p.limited, canStart: p.slots || {}, running: running[id] || 0, speed: p.speed || prov[id === 'go2' ? 'go' : id]?.speed || 'normal', mode: p.mode || prov[id === 'go2' ? 'go' : id]?.mode || 'normal', off: !!p.off }); }
  return { providers: out, total: Object.values(running).reduce((n, x) => n + x, 0), running };
}
function buildDigest(base) {
  const now = Date.now(), DAY = 86400e3;
  let stProjects = {}; try { stProjects = JSON.parse(readText(`${RUN}/state.json`)).projects || {}; } catch {}
  const lines = readText(`${RUN}/driver.log`).trim().split(/\r?\n/).slice(-4000);
  const ev = new Map(); // dir -> [{t, verb, text}] newest last
  for (const l of lines) {
    const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (\S+) (\d\d-[\w.-]+) ?(.*)$/.exec(l); if (!m) continue;
    const t = Date.parse(m[1].replace(' ', 'T')); if (!ev.has(m[3])) ev.set(m[3], []);
    ev.get(m[3]).push({ t, verb: m[2], text: m[4] });
  }
  let counts = [], asks = [], ap = null; try { ap = approvals(); counts = ap.projects; asks = (ap.items || []).filter((i) => i.project === 'watcher' && i.kind === 'ask' && !i.done); } catch {}
  const plans = [], finishedRows = [], olderDone = [];
  for (const p of base.projects || []) {
    const e = ev.get(p.dir) || [], last = e.at(-1);
    const live = (p.working || []).filter((w) => w.role !== 'manual'), manual = (p.working || []).some((w) => w.role === 'manual' && !w.idle);
    const stages = (p.rev?.cols || STAGES).filter(Boolean);
    const idx = Math.max(0, stages.indexOf(p.stage));
    const state = p.stage === 'done' ? 'done' : /-gate$/.test(p.stage) && !p.held ? 'gate' : live.length ? 'running'
      : p.held ? 'held' : p.cooldownUntil && p.cooldownUntil > now ? 'cooldown' : 'waiting';
    // the "finished in the last N days" strip (up to 7 days, the page filters): every plan now done, even ones the line below drops
    if (state === 'done') { const dAt = lastDoneAt(e); if (dAt && now - dAt < FINISHED_MAX_DAYS * DAY) finishedRows.push({ dir: p.dir, at: dAt, pct: auditEstimate(readText(`${PLANS}/${p.dir}/_build/VERIFY.md`))?.pct ?? verifyRate(readText(`${PLANS}/${p.dir}/_build/VERIFY.md`)) ?? p.progress?.pct ?? null }); }
    // keep what a status answer would mention: anything not held/done, plus held/done plans that moved in the last day
    // Done plans that last moved 1-7 days ago go to olderDone: the page adds them to the table when its day window covers them (finished.mjs).
    const dropped = (state === 'done' || state === 'held') && !(last && now - last.t < DAY) && !manual && p.dir !== integrations.auditPlan && p.dir !== integrations.remotePlan; // Configured feature plans keep their verification and feature list visible.
    if (dropped && !(state === 'done' && last && now - last.t < FINISHED_MAX_DAYS * DAY)) continue;
    const into = dropped ? olderDone : plans;
    const b = `${PLANS}/${p.dir}/_build`, doneAt = state === 'done' ? ([...e].reverse().find((x) => x.verb === 'advance' && x.text.endsWith('-> done (ok)'))?.t || null) : null;
    const says = p.progress ? auditSays(readText(`${b}/${p.progress.round}/AUDIT.md`), p.progress.text) : null, rn = state === 'done' ? null : roundNotes(p.dir, p.stage);
    const final = state === 'done' ? (auditEstimate(readText(`${b}/VERIFY.md`))?.pct ?? verifyRate(readText(`${b}/VERIFY.md`)) ?? p.progress?.pct ?? null) : null;
    const since = [...e].reverse().find((x) => (x.verb === 'advance' && x.text.endsWith(`-> ${p.stage} (ok)`)) || (x.verb === 'launch' && x.text.startsWith(p.stage)))?.t || p.activeBuild?.gateAt || null;
    // previous audit estimate, for the trend arrow
    let prev = null;
    if (p.progress) {
      const rs = [];
      for (let n = p.rev?.n || 2; n >= 1; n--) rs.push(`v${n}-r3`, `v${n}-r2`, `v${n}-r1`);
      const after = rs.slice(rs.indexOf(p.progress.round) + 1);
      for (const r of after) { const x = auditEstimate(readText(`${b}/${r}/AUDIT.md`)); if (x) { prev = { round: r, pct: x.pct }; break; } }
    }
    const rounds = stages.filter((x) => /^v\d+-r\d$/.test(x) && x.startsWith(p.stage.split('-')[0] + '-')).length || 3;
    const c = counts.find((x) => x.project === p.dir);
    const nxt = state === 'done' ? null : stages[idx + 1] || null;
    into.push({ dir: p.dir, cat: p.cat, state, stage: p.stage, headline: p.held && /-gate$/.test(p.stage) ? 'on hold: the owner works on it by hand' : stagePlain(p.stage, rounds), stages, idx, rev: p.rev?.n || null,
      audit: p.progress ? { pct: p.progress.pct, round: p.progress.round } : null, prev,
      models: live.map((w) => ({ role: w.role, provider: w.provider, model: w.model, task: w.task || '', paused: !!w.paused })),
      since, held: p.held ? String(p.held).slice(0, 160) : null, cooldownUntil: p.cooldownUntil || null,
      last: last ? { t: last.t, text: `${last.verb} ${last.text}`.slice(0, 160) } : null,
      next: nxt ? stagePlain(nxt, rounds) : null, thenGate: !!nxt && /-gate$/.test(nxt), open: c?.openOwner || 0, apPage: c?.apPage || null, page: c?.page || null, tokens: p.tokens,
      manual, says, workers: rn?.workers || [], orch: rn?.orch || null, idleMin: rn?.newest && live.length ? Math.round((now - rn.newest) / 60e3) : null,
      paused: live.filter((w) => w.paused).map((w) => `${w.role} (${w.model || w.provider})`), doneAt, final, features: p.dir === integrations.auditPlan ? featureList() : null,
      cost: p.cost || 0, revLabel: p.rev?.label || null, ...planExtras(p.dir, stages, stProjects[p.dir]?.history) });
  }
  const order = { running: 0, gate: 1, cooldown: 2, waiting: 3, done: 4, held: 5 };
  plans.sort((a, b) => order[a.state] - order[b.state] || a.dir.localeCompare(b.dir));
  olderDone.sort((a, b) => b.last.t - a.last.t);
  const all = base.projects || [];
  const tally = { running: 0, waiting: 0, gate: 0, cooldown: 0, done24: 0, held: all.filter((p) => p.held && p.stage !== 'done').length, doneAll: all.filter((p) => p.stage === 'done').length, total: all.length };
  for (const x of plans) if (x.state === 'done') { if (x.doneAt) tally.done24++; } else if (tally[x.state] != null && x.state !== 'held') tally[x.state]++;
  let lim = []; try { lim = (budget().limits || []).map((l) => ({ id: l.id, name: l.name, provider: l.provider, windows: (l.windows || []).filter((w) => ['5h', '7d'].includes(w.label)).map((w) => ({ label: w.label, pct: w.pct, resetsAt: w.resetsAt })) })); } catch {}
  const health = healthNow(base), stalled = plans.filter((x) => x.state === 'running' && x.idleMin != null && x.idleMin >= 40).map((x) => ({ dir: x.dir, stage: x.stage, idleMin: x.idleMin }));
  const pausedN = plans.reduce((n, x) => n + x.paused.length, 0), trouble = stalled.length + pausedN, t = tally, s = (n) => (n === 1 ? '' : 's');
  // the one-line verdict a status answer opens with
  // SuperAgent hand-offs (Agent tool, agent.sh, headless-take, jobs-track run): every running tracked job that is not a driver job
  { const g = trackedNow(); t.agents = [...g.plans.values(), ...g.other.values()].flat().filter((j) => j.status === 'running' && j.kind !== 'autonomous').length; }
  const ag = t.agents ? `, ${t.agents} subagent${s(t.agents)} running` : '';
  let line = !base.driverAlive ? (base.driverRestarting ? 'Driver restarting (watchdog relaunches it within 5 min)' : 'Driver off. Nothing moves until it restarts') + ag : t.running ? `${t.running} plan${s(t.running)} building${ag}` : t.agents ? `${t.agents} subagent${s(t.agents)} running, no plan building` : t.cooldown ? `${t.cooldown} plans waiting to retry; check provider errors` : t.waiting ? `Nothing building yet, ${t.waiting} waiting for a slot` : 'Idle, every plan is held or done';
  const cloudOn = (() => { try { return JSON.parse(fs.readFileSync(`${RUN}/modes.json`, 'utf8')).cloud !== 'off'; } catch { return true; } })();
  if (cloudOn && exists(`${RUN}/flags/cloud-access-denied`)) line = 'Claude cloud access denied (HTTP 403); cloud builds cannot proceed';
  if (t.gate) line += `, ${t.gate} wait${t.gate === 1 ? 's' : ''} on your audit`;
  line += trouble ? `, ${trouble} need${trouble === 1 ? 's' : ''} a look.` : t.running ? ', nothing blocked.' : '.';
  // blocked on you: gates first, then plans with open approval items, then what the watcher asked in chat
  const you = plans.filter((x) => x.state === 'gate').map((x) => ({ kind: 'gate', dir: x.dir, text: 'audit it, then approve or redo', apPage: x.apPage }))
    .concat(asks.slice(-3).reverse().map((a) => ({ kind: 'ask', dir: 'watcher', text: String(a.title).slice(0, 160), cmd: a.cmd || null, added: a.added || null })));
  const finished = finishedWithin(finishedRows, now, FINISHED_MAX_DAYS); // 7 days; the page narrows it to the viewer's choice (finished.mjs)
  // flagged items for the Warnings view: critical = data loss words, stalls, pauses, driver off; warn = the rest
  const cloudDenied = cloudOn && exists(`${RUN}/flags/cloud-access-denied`);
  const LOSS = /\b(delet|overwr|wiped|lost|destroy|removed|truncat|clobber)/i, flags = [];
  if (cloudDenied) flags.push({level:'critical',where:'cloud access',dir:'',text:'Claude cloud access denied (HTTP 403). Upload retries blocked until access is restored.'});
  if (!base.driverAlive && !base.driverRestarting) flags.push({ level: 'critical', where: 'driver', dir: '', text: 'The driver is off. Nothing moves until it restarts.' });
  for (const x of stalled) flags.push({ level: 'critical', where: 'stall', dir: x.dir, text: `wrote nothing for ${x.idleMin} min on ${x.stage}` });
  for (const x of plans) {
    for (const w of x.paused) flags.push({ level: 'warn', where: 'paused', dir: x.dir, text: `${w} is paused by a usage limit` });
    if (x.orch && LOSS.test(x.orch)) flags.push({ level: 'critical', where: 'coordinator note', dir: x.dir, text: x.orch });
    if (x.says?.risk && LOSS.test(x.says.risk)) flags.push({ level: 'critical', where: 'audit risk', dir: x.dir, text: x.says.risk });
    if (x.says?.verdict && LOSS.test(x.says.verdict)) flags.push({ level: 'critical', where: 'audit verdict', dir: x.dir, text: x.says.verdict });
    if (x.audit && x.audit.pct < 60) flags.push({ level: 'warn', where: 'audit', dir: x.dir, text: `audit ${x.audit.round} at ${x.audit.pct}%` });
    if (x.state === 'gate') flags.push({ level: 'warn', where: 'gate', dir: x.dir, text: 'waits for your audit' });
  }
  for (const y of you) if (y.kind === 'ask') flags.push({ level: 'warn', where: 'SuperAgent ask', dir: '', text: y.text + (y.added ? ` (asked ${y.added})` : '') });
  if (health.free?.total && health.free.paused >= Math.ceil(health.free.total / 2)) flags.push({ level: 'warn', where: 'free models', dir: '', text: `${health.free.paused} of ${health.free.total} rate-limited` });
  if (health.queue && !health.queue.armed && t.running) flags.push({ level: 'warn', where: 'audit queue', dir: '', text: 'queue watch is not running' });
  if (health.mem?.usedPct >= 85) flags.push({ level: 'critical', where: 'memory', dir: '', text: `RAM ${health.mem.usedPct}% used` });
  if (health.tmp?.usedPct >= 80) flags.push({ level: 'critical', where: 'temporary storage', dir: '', text: `Temporary storage ${health.tmp.usedPct}% full` });
  for (const l of lim) for (const w of l.windows) if (w.pct >= 90) flags.push({ level: 'warn', where: 'usage', dir: '', text: `${l.name} ${w.label} at ${w.pct}%` });
  const lastLaunch = Math.max(0, ...plans.map((x) => x.since || 0));
  const speed = speedNow(base), prio = ap?.priorities || { projects: {} };
  let blockers = null, optimize = [], deep = {}; try { blockers = rankBlockers({ items: ap?.items || [], prio, plans }); } catch (e) { console.error('blockers failed', e); } try { const o = optimizeTips({ lines: readText(`${RUN}/driver.log`).split('\n').slice(-60000), plans, health, speed, tally, prio }); optimize = o.tips; deep.opt = { stops: o.stops, spend: o.spend, runs: o.runs, heavy: o.heavy }; } catch (e) { console.error('optimize failed', e); }
  try { deep.flags = enrichFlags(flags, { plans, items: ap?.items || [], apPages: ap?.apPages || {}, lim }); deep.health = healthDeep(health); deep.watcher = watcherDeep(); } catch (e) { console.error('deep flags failed', e); } // the Warnings and flags view
  return { at: now, next: now + DIGEST_MS, driverAlive: base.driverAlive, driverRestarting: !!base.driverRestarting, tally, limits: lim, plans, olderDone, line, you, finished, health, stalled, watcher: watcherSaid(), flags, speed, lastLaunch, blockers, optimize, deep, apPages: ap?.apPages || {} };
}
function statusDigest(base) {
  if (!digestCache || digestCache.driverAlive !== base.driverAlive || digestCache.driverRestarting !== !!base.driverRestarting || digestCache.tally?.agents !== (() => { const g = trackedNow(); return [...g.plans.values(),...g.other.values()].flat().filter((j) => j.status === "running" && j.kind !== "autonomous").length; })() || Date.now() - digestCache.at >= DIGEST_MS || claimsMtime() > digestCache.at) { // claims/pins changed: the watcher checked something
    try { digestCache = buildDigest(base); fs.writeFileSync(DIGEST_FILE, JSON.stringify(digestCache)); } catch (e) { console.error('status digest failed', e); }
  }
  return digestCache;
}

// Trials: detail page /trials/<id>, same dark theme as the dashboard
const TRIALS = makeTrials({ RUN, PLANS, readText });
function trialPage(t) {
  const e = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const k = (n) => n == null ? '-' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
  const m = (v) => !v ? 'none yet' : v.unit === '$' ? `$${v.value}` : `${k(v.value)} ${v.unit}${v.cost != null ? `, $${v.cost}` : ''}${v.over100k != null ? `, ${v.over100k}% over 100k` : ''}${v.done != null ? `, ${v.done}% DONE` : ''}`;
  const rows = t.runs.map((r) => `<tr><td>${e(r.plan)}</td><td>${e(r.step)}</td><td>${e(r.at ? new Date(r.at).toLocaleString('en-US', { timeZone: 'America/Chicago' }) : '')}</td><td class="n">${r.cost == null ? '-' : '$' + r.cost.toFixed(2)}</td><td class="n">${k(r.tokens)}</td><td class="n">${k(r.peakCtx)}</td><td>${e(r.outcome)}</td><td><code>plans/${e(r.files)}</code></td></tr>`).join('') || '<tr><td colspan="8">No runs yet.</td></tr>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trial: ${e(t.name)}</title><style>
:root{color-scheme:dark;--bg:#0b0c0e;--panel:#121418;--panel2:#171a1f;--line:#23272e;--ink:#e9ebee;--ink2:#a9b0ba;--ink3:#6f7782;--ok:#2fd69c;--bad:#e2554f;--warn:#e0a84f}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,sans-serif;padding:20px 16px}main{max-width:1100px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}a{color:#8ab4ff}.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:12px 0}
.v{font-weight:700}.v.better{color:var(--ok)}.v.worse{color:var(--bad)}.v.pending{color:var(--warn)}.k{color:var(--ink3);font-size:11px;text-transform:uppercase;letter-spacing:.06em}code{background:var(--panel2);padding:1px 6px;border-radius:5px;font-size:12px}
.w{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--ink3);font-weight:500}.n{text-align:right}</style></head><body><main>
<a href="/">&larr; AgentGlim</a><h1>Trial: ${e(t.name)} <span class="v ${t.verdict}">${t.verdict}</span></h1><div style="color:var(--ink2)">${e(t.what)}</div>
<div class="card"><div class="k">Progress</div>${t.n} of ${t.target} runs${t.left != null ? ` (${t.left} left on the counter)` : ''}<div class="k" style="margin-top:10px">Current</div>${e(m(t.current))}<div class="k" style="margin-top:10px">Baseline (${e(t.baseline.label)})</div>${e(m(t.baseline))}${t.baseline.n ? ` from ${t.baseline.n} sessions` : ''}${t.baseline.peakCtx ? `, avg peak context ${k(t.baseline.peakCtx)}` : ''}<div class="k" style="margin-top:10px">Revert</div><code>${e(t.revert)}</code></div>
<div class="card w"><table><thead><tr><th>Plan</th><th>Step</th><th>Date</th><th class="n">Cost</th><th class="n">Tokens</th><th class="n">Peak ctx</th><th>Outcome</th><th>Files</th></tr></thead><tbody>${rows}</tbody></table></div></main></body></html>`;
}

function observatoryRow() {
  let ups = []; try { ups = JSON.parse(readText(`${DATA}/updates.json`) || '[]'); } catch {}
  const open = ups.filter((u) => u.status !== 'done');
  const cur = open.reduce((a, u) => Math.min(a, Math.max(0, UPDATE_STAGES.indexOf(u.status))), 3);
  const mine = `${PLANS}/_observatory`;
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; let cost = 0;
  for (const { model, u, session } of claudeMsgs.values()) {
    if (!(claudeCwd.get(session) || '').startsWith(mine)) continue;
    const pr = claudePrice(model);
    const inp = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0, out = u.output_tokens || 0;
    t.input += inp; t.output += out; t.cacheRead += cr; t.cacheWrite += cw;
    cost += (inp * pr.input + cr * pr.cached + cw * pr.write + out * pr.output) / 1e6;
  }
  for (const c of codexFiles.values()) if (c.cwd?.startsWith(mine)) for (const x of c.turns) { t.input += x.input; t.output += x.output; t.cacheRead += x.cached; cost += codexCost(x, x.model); }
  const man = manualSessions.get('_observatory') || [];
  const review = open.filter((u) => u.status === 'review').map((u) => Date.parse(u.at) || 0).filter(Boolean);
  const done = ups.length - open.length;
  // Agentglim as one project (consolidation): per-feature sub-rows from ../features.json;
  // features with a "plan" (68, 55) show that plan's live state in index.html subRows.
  let sub = []; try { sub = displayLiveStatus(JSON.parse(fs.readFileSync(new URL('../features.json', import.meta.url), 'utf8')).features.map((f) => ({ id: f.id, title: f.title, status: f.status, pct: f.pct, plan: f.plan || undefined,
    note: `${f.tasks.filter((t) => t.s === 'done').length}/${f.tasks.length} sub-tasks done · ${f.source}<br>${f.evidence}`, updated: f.updated })), repoPlans().agentglim || 'agentglim', [...trackedNow().plans.values(), ...trackedNow().other.values()].flat()); } catch {}
  return { dir: 'observatory', label: 'AgentGlim', sub, stage: open.length ? `obs-${UPDATE_STAGES[cur]}` : 'done', stageIndex: cur, cat: categories().plans.observatory || 'Ops',
    updates: ups.slice(-12), tokens: t.input + t.output + t.cacheRead, cost, active: man.length,
    progress: ups.length ? { pct: Math.round(100 * done / ups.length), label: `${done}/${ups.length} updates`, tip: `<b>${done} of ${ups.length}</b> Observatory updates done`
      + open.map((u) => `<br>${u.status}: ${u.title}`).join('') } : null,
    activeBuild: { note: 'Observatory updates', gateAt: cur === 1 && review.length ? Math.min(...review) : null },
    working: man.map(manualWork) };
}

function flags() {
  const f = {};
  try {
    for (const n of fs.readdirSync(`${RUN}/flags`)) f[n] = fs.statSync(`${RUN}/flags/${n}`).mtimeMs;
  } catch {}
  return f;
}

// ---------- leads campaign (read-only): newest campaign.json + each chunk's controller status.json ----------
const LEADS = integrations.leadsPath;
function leadsStatus() {
  if (!LEADS) return null;
  const root = `${LEADS}/.artifacts/campaign`;
  const files = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()))
    for (const n of fs.readdirSync(`${root}/${d.name}`)) if (fs.existsSync(`${root}/${d.name}/${n}/campaign.json`)) files.push(`${root}/${d.name}/${n}/campaign.json`);
  if (!files.length) return null;
  const f = files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  const c = JSON.parse(readText(f));
  const chunks = (c.chunks || []).map((x) => {
    let st = {};
    try { st = JSON.parse(readText(`${LEADS}/.artifacts/controller/${c.run_date}/${x.run}/status.json`)); } catch {}
    const b = (st.batches || []).map((y) => ({ batch: y.batch, state: y.state, step: y.last_step, rows: y.rows, delivered: y.delivered, qualified: y.qualified, parked: y.parked, usd: y.spend_usd }));
    return { n: x.n, run: x.run, status: x.status, rows: x.rows, delivered: x.delivered || 0, qualified: x.qualified || 0, usd: x.spend_total_usd || 0,
      reason: x.status === 'done' ? '' : (x.reason || x.outcome_reason || ''), message: x.status === 'done' ? '' : (x.message || ''), recommended: x.recommended || '', batches: b };
  });
  const sum = (k) => chunks.reduce((n, x) => n + (x[k] || 0), 0);
  const ev = (c.events || []).slice(-1)[0] || null;
  return { name: c.name, file: f.slice(LEADS.length + 1), outcome: c.outcome, phase: c.phase, processing: c.processing, profile: c.profile, rows: c.rows, capUsd: c.max_usd_total,
    delivered: sum('delivered'), qualified: sum('qualified'), usd: sum('usd'), lastEvent: ev, stage4: !!c.stage4, chunks };
}

// ---------- email sequence (read-only, counts only: no emails, names or contact data leave this function) ----------
// state/ is written by email-sequence/sequence.py: pushed.csv (pushed_at,email,campaign_id) and replies.csv
// (marked_at,email,outcome,note; the last row per email is its outcome). Report pages: state/reports.csv, the registry
// `sequence.py report build` keeps (slug,email,website,created,expires,status draft|approved); only counts leave here.
const EMAILSEQ = integrations.emailSequencePath;
const emailSeqGit = { head: null };
function refreshEmailSeqGit() {
  if (!EMAILSEQ) return;
  execFile('git', ['-C', EMAILSEQ, 'log', '-1', '--format=%h%x00%s%x00%cI'], { timeout: 10000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_CEILING_DIRECTORIES: path.dirname(EMAILSEQ), GIT_TERMINAL_PROMPT: '0' } },
  (err, so) => { const [sha, subject, date] = String(so || '').trim().split('\0'); emailSeqGit.head = !err && sha ? { sha, subject, date } : null; });
}
if (EMAILSEQ) { refreshEmailSeqGit(); setInterval(refreshEmailSeqGit, 60000); }
function csvRows(file) {
  const t = readText(file).replace(/^﻿/, ''); if (!t.trim()) return null;
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"' && t[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((x) => x !== ''));
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}
function emailSeqStatus() {
  if (!EMAILSEQ || !fs.existsSync(EMAILSEQ)) return null;
  const pushed = csvRows(`${EMAILSEQ}/state/pushed.csv`), replies = csvRows(`${EMAILSEQ}/state/replies.csv`);
  const byCampaign = {};
  for (const r of pushed || []) byCampaign[r.campaign_id || '?'] = (byCampaign[r.campaign_id || '?'] || 0) + 1;
  const latest = new Map(); // email -> outcome (last row wins, as sequence.py read_state)
  for (const r of replies || []) if (r.email) latest.set(r.email.toLowerCase(), r.outcome || 'other');
  const outcomes = { yes: 0, no: 0, bounced: 0, unsubscribed: 0, other: 0 };
  for (const o of latest.values()) outcomes[o in outcomes ? o : 'other'] += 1;
  // report pages: live = expires after today (as report.py active_report); drafts/approved/expiring counted among live pages
  const reg = csvRows(`${EMAILSEQ}/state/reports.csv`);
  let reports = null;
  if (reg) {
    const d = new Date(), iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    const today = iso(d), soon = iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7));
    const live = reg.filter((r) => /^\d{4}-\d{2}-\d{2}/.test(r.expires || '') && r.expires.slice(0, 10) > today);
    reports = { total: reg.length, live: live.length, expired: reg.length - live.length,
      draft: live.filter((r) => (r.status || 'draft') === 'draft').length, approved: live.filter((r) => r.status === 'approved').length,
      expiringSoon: live.filter((r) => r.expires.slice(0, 10) <= soon).length };
  }
  return { head: emailSeqGit.head, campaign: !!(pushed || replies), pushed: pushed ? pushed.length : 0,
    byCampaign: Object.entries(byCampaign).map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n), marked: latest.size, outcomes, reports };
}

// ---------- other projects (others.mjs): priced with the same rates and billing classes as the run ----------
const others = makeOthers({ rateOf, partCost, recClass, trackedJobs: (name) => trackedNow().other.get(name) || [], leadsUsd: () => { try { return leadsStatus()?.usd ?? null; } catch { return null; } } });
setTimeout(() => { try { others.scanSessions(); } catch (e) { console.error('other projects scan failed', e); } }, 3000);
setInterval(() => { try { others.scanSessions(); } catch (e) { console.error('other projects scan failed', e); } }, 30000);

// live, unfiltered state shared by every viewer; rebuilt every 5 s
let lastHistory = 0;
function scan() {
  const state = JSON.parse(readText(`${RUN}/state.json`) || '{"projects":{}}');
  scanClaudeQueue();
  scanLive();
  // CPU fix 2026-11-13: the full _build walk (~67k folders) and finished-job rescans run every 5 min;
  // between them, known jobs plus live/queued dirs, and only jobs that are not finished
  { const full = !jobDirs || Date.now() - jobDirsAt > 300e3;
    if (full) { jobDirs = new Set(walkJobs()); jobDirsAt = Date.now(); }
    else for (const d of [...liveDirs, ...claudeQueue.keys()]) if (!jobDirs.has(d) && exists(`${d}/meta`)) jobDirs.add(d);
    for (const d of jobDirs) { const j = jobs.get(d); if (!full && j && j.rc && !j.active && !claudeQueue.has(d) && !liveDirs.has(d)) continue; scanJob(d); } }
  scanZen();
  // from the run start, or the first job if an earlier attempt left some (in the imported copy)
  const firstJob = Math.min(...[...jobs.values()].map((j) => j.started).filter(Boolean));
  const since = Math.min(Date.parse(String(state.started || '').replace(' ', 'T')) || Date.now() - 86400e3, firstJob);
  try { scanClaude(since); haikuUsage(); } catch (e) { console.error('claude scan failed', e); }
  try { scanJev(); } catch (e) { console.error('jev scan failed', e); }
  try { scanEleven(); } catch (e) { console.error('elevenlabs scan failed', e.message); }
  try { scanCodex(since); } catch (e) { console.error('codex scan failed', e); }
  try { saveRunModels(); } catch (e) { console.error('run model list failed', e); }
  loadBilling();
  const log = readText(`${RUN}/driver.log`).trim().split('\n').slice(-40).reverse();
  let driverAlive = false;
  // SuperAgent watchers: the harness's queue watcher and 30-minute check when their scripts are installed,
  // otherwise the one private SuperAgent heartbeat any harness (Codex included) is told to touch. app/watchers.mjs
  const watchers = watcherState({ data: DATA, run: RUN });
  let driverRestarting = false;
  try { driverAlive = alive(Number(readText(`${RUN}/driver.pid`).trim())); } catch {}
  // also alive: any `node driver.mjs run` process (the pid file can lag a self-reload); restarting: the watchdog relaunched it in the last 10 min
  if (!driverAlive) driverAlive = listProcesses().some(({ args }) => /driver\.mjs\0run/.test(args.join('\0')));
  if (!driverAlive) driverRestarting = log.slice(0, 40).some((l) => / watchdog: driver not running/.test(l) && Date.now() - Date.parse(l.slice(0, 19).replace(' ', 'T')) < 10 * 60e3);
  const providers = new Set(['codex', 'anthropic']);
  for (const r of recs.values()) providers.add(r.provider);
  try { seedBaseline(); } catch (e) { console.error('baseline seed failed', e); }
  let pending = [];
  try { pending = review(); } catch (e) { console.error('review failed', e); }
  for (const j of jobs.values()) if (provOf(j)) providers.add(provOf(j));
  const driverInstalled = ['driver.mjs', 'driver.pid', 'driver.log', 'bin/driver.mjs'].some((f) => has(`${RUN}/${f}`)); // the optional plans driver: no files, no "Driver is off"
  const base = { started: state.started, driverAlive, driverRestarting, driverInstalled, watchers, flags: flags(), dsCap: DS_CAP_USD, projects: projects(state), userIcons: projectIcons(DATA), planIcons: (() => { try { return planIconsFor(PLANS, `${DATA}/plan-icons.json`); } catch { return {}; } })(), obsRow: (() => { try { return observatoryRow(); } catch (e) { return null; } })(), watcherRow: (() => { try { return saJobs(watcherRow()); } catch (e) { return null; } })(), inboxResend: (() => { try { return inboxResendStatus(); } catch (e) { return { error: String(e.message || e), checkedAt: Date.now() }; } })(), subArchived: (() => { try { return archivedMap(); } catch (e) { return {}; } })(), subProjects: (() => { try { return subProjects(); } catch (e) { return { parents: {}, parentReal: {} }; } })(), otherRows: (() => { const RP = repoPlans(); const rows = Object.entries(Object.groupBy(otherSessions, (m) => m.project)).filter(([dir, l]) => dir && !RP[dir] && !dir.startsWith('_') && dir !== 'jobtrack-test' && l.some((m) => !m.idle)).map(([dir, l]) => ({ dir, other: true, active: l.length, working: l.map(manualWork), tracked: [] }));
      for (const [dir, tl] of trackedNow().other) { if (dir === 'SuperAgent') continue; let r = rows.find((x) => x.dir === dir); if (!r) rows.push(r = { dir, other: true, active: 0, working: [], tracked: [] }); r.tracked = tl; r.active += tl.filter((j) => j.status === 'running').length; }
      if (!rows.some((r) => r.dir === 'goals') && fs.existsSync(path.join(PROJECTS, 'goals'))) rows.push({ dir: 'goals', other: true, active: 0, working: [], tracked: [] });
      return rows; })(), catColors: categories().colors, self: selfStatus(), log, review: pending, prices: prices(),
    integrations: integrationView(),
    reviewOptions: { providers: PROVIDERS, classes: CLASSES },
    providers: [...providers].sort(),
    // the current local models, not the retired iq3_xxs model id
    localModel: LOCAL_MODELS,
    directSpend: [...recs.values()].reduce((n, r) => n + (r.provider === 'deepseek' ? r.cost : 0), 0),
    leads: (() => { try { return leadsStatus(); } catch (e) { if (e.code !== 'ENOENT') console.error('leads scan failed', e); return null; } })(),
    fleet: (() => { try { const f = readFleet(); return f.path ? f : null; } catch (e) { console.error('fleet scan failed', e); return { state: 'error', message: 'fleet read failed' }; } })(),
    emailSeq: (() => { try { return emailSeqStatus(); } catch (e) { console.error('email sequence scan failed', e); return null; } })() };
  if (Date.now() - lastHistory > 60000) {
    lastHistory = Date.now();
    const byClass = summarize([...recs.values()]).byClass;
    fs.appendFileSync(`${DATA}/history.ndjson`, JSON.stringify({ t: Date.now(), active: [...jobs.values()].filter((j) => j.active).length, byClass, directSpend: base.directSpend }) + '\n');
  }
  return base;
}

// chart series: provider colors, with OpenCode Go split into DeepSeek and other paid models (its free ones chart as free)
const goSplit = (r) => r.provider === 'opencode-go' && !isFree(r) ? (/deepseek/i.test(r.model) ? 'goDs' : 'goOther') : null;
const seriesOf = (r) => r.provider === 'deepseek' ? 'ds' : r.provider === 'jev' ? 'jev' : r.provider === 'elevenlabs' ? 'el' : r.provider === 'antigravity' ? 'antigravity' : r.provider === 'openrouter' && recClass(r) === 'paid-api' ? 'or' : goSplit(r) || (r.provider === 'codex' ? 'codex' : r.provider === 'anthropic' ? 'claude' : recClass(r));
function summarize(rs) {
  const byClass = {}; const byProvider = {}; const rows = {};
  for (const r of rs) {
    const c = recClass(r); const tok = r.input + r.output + r.cacheRead + (r.cacheWrite || 0);
    const a = (byClass[c] ||= { tokens: 0, cost: 0, calls: 0 });
    a.tokens += tok; a.cost += r.cost; a.calls += r.calls;
    const b = (byProvider[r.provider] ||= { class: c, tokens: 0, cost: 0, calls: 0 });
    b.tokens += tok; b.cost += r.cost; b.calls += r.calls;
    const g = goSplit(r);
    const orPaid = r.provider === 'openrouter' ? (c === 'paid-api' ? ' · paid' : ' · free') : r.provider === 'opencode-go' && c === 'free' ? ' · free' : '';
    const key = g ? `opencode-go · ${g === 'goDs' ? 'deepseek' : 'other models'}` : c === 'local' ? localName(r.provider, r.model) : r.provider + orPaid;
    const series = g || (r.provider === 'openrouter' ? (c === 'paid-api' ? 'or' : 'free') : r.provider === 'opencode-go' && c === 'free' ? 'free' : r.provider);
    const row = (rows[key] ||= { key, provider: r.provider, series, class: c, est: !!r.est, sub: c === 'free' ? 0 : SUB_PRICE[r.provider] || 0, tokens: 0, cost: 0, calls: 0,
      input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, rated: 0, cacheSaved: 0, models: new Set() });
    row.tokens += tok; row.cost += r.cost; row.calls += r.calls;
    row.input += r.input; row.cacheRead += r.cacheRead; row.cacheWrite += r.cacheWrite || 0; row.output += r.output; row.reasoning += r.reasoning || 0;
    const p = rateOf(r); row.rated += partCost(r, p); row.cacheSaved += cacheSaved(r, p); row.models.add(c === 'local' ? localShort(r.provider, r.model) : r.model);
  }
  for (const row of Object.values(rows)) row.models = [...row.models];
  return { byClass, byProvider, provRows: Object.values(rows).sort((a, b) => b.tokens - a.tokens) };
}

// filter from the query string: from/to in ms (to open = up to now), x = excluded providers
function parseFilter(url) {
  const q = new URL(url, 'http://x').searchParams;
  const from = Number(q.get('from')) || 0, to = Number(q.get('to')) || 0;
  const excl = new Set((q.get('x') || '').split(',').filter(Boolean));
  return { from, to, excl, inRange: (t) => t >= from && (!to || t < to) };
}

function subRecs(f) {
  const out = [];
  const add = (ts, provider, model, input, output, cacheRead, cost, cacheWrite = 0, reasoning = 0) => {
    if (!f.inRange(ts) || f.excl.has(provider)) return;
    out.push({ t: Math.floor(ts / BUCKET_MS) * BUCKET_MS, provider, model, input, output, cacheRead, cacheWrite, reasoning, cost, calls: 1, est: true });
  };
  for (const c of codexFiles.values()) {
    if (!c.cwd?.startsWith(PLANS)) continue;
    for (const t of c.turns) add(t.ts, 'codex', t.model, t.input, t.output, t.cached, codexCost(t, t.model), t.write || 0, t.reasoning);
  }
  for (const { model, u, ts } of claudeMsgs.values()) {
    const p = claudePrice(model);
    const inp = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0, out_ = u.output_tokens || 0;
    add(ts, 'anthropic', model, inp, out_, cr, (inp * p.input + cr * p.cached + cw * p.write + out_ * p.output) / 1e6, cw);
  }
  return out;
}

const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function view(base, f) {
  const now = Date.now();
  const rs = [...recs.values()].filter((r) => f.inRange(r.t) && !f.excl.has(r.provider));
  const all_ = rs.concat(subRecs(f)); // + Codex and Claude subscription usage, priced as API estimates
  const { byClass, byProvider, provRows } = summarize(all_);
  // chart bucket from the visible span: 10 min up to 1.5 days, hourly up to 10 days, then daily
  const first = all_.length ? all_.reduce((m, r) => (r.t < m ? r.t : m), Infinity) : now; // reduce, not Math.min(...): a full-range snapshot overflowed the stack and crashed the server (2026-11-10)
  const lo = Math.max(f.from, first), hi = f.to || now;
  const span = hi - lo;
  const bucketMs = span <= 36 * 3600e3 ? BUCKET_MS : span <= 10 * 86400e3 ? 3600e3 : 86400e3;
  const key = (t) => bucketMs === 86400e3 ? startOfDay(t) : Math.floor(t / bucketMs) * bucketMs;
  const rows = new Map(), spendRows = new Map();
  for (let t = key(lo); t <= hi; t = bucketMs === 86400e3 ? startOfDay(t + 30 * 3600e3) : t + bucketMs) { rows.set(t, { t }); spendRows.set(t, { t }); }
  for (const r of all_) {
    const t = key(r.t);
    const row = rows.get(t) || rows.set(t, { t }).get(t), sp = spendRows.get(t) || spendRows.set(t, { t }).get(t);
    const c = seriesOf(r), cls = recClass(r);
    row[c] = (row[c] || 0) + r.input + r.output + r.cacheRead;
    // spend view: cost at the model's rates (billed for paid, API-equivalent for subscriptions);
    // free and local count what they saved, quality-adjusted at DS Flash rates like the Saved cards
    sp[c] = (sp[c] || 0) + (cls === 'free' || cls === 'local' ? dsCost(r) * qualityOf(r.model) : partCost(r, rateOf(r)));
  }
  const series = [...rows.values()].sort((a, b) => a.t - b.t), spendSeries = [...spendRows.values()].sort((a, b) => a.t - b.t);
  // agents: running now, plus any job that overlapped the range
  const all = [...jobs.values()].filter((j) => !f.excl.has(provOf(j)));
  const inRange = all.filter((j) => j.active || (j.started && j.started < (f.to || Infinity) && (j.ended || now) >= f.from));
  const active = all.filter((j) => j.active);
  inRange.sort((a, b) => (b.active - a.active) || (b.started || 0) - (a.started || 0));
  const days = Math.max(1, Math.ceil((hi - (f.from || first)) / 86400e3));
  updateSubscriptionPrices();
  const sv = (() => { try { return setupView(); } catch (e) { console.error('setup view failed', e); return null; } })(); // Setup page choices (2026-11-11)
  return {
    ...base, now, build: pageBuildId(), subPrice: SUB_PRICE, modelIcons: iconStore, apiKeys: apiKeys(), elevenlabs: elevenSub(),
    // read at view time, not scan time: a heartbeat the user just touched shows on the next request
    watchers: watcherSnapshot({ data: DATA, run: RUN }), ...(({ limits, mode, order }) => ({ limits: sv ? limits.filter((l) => sv.limitIds.includes(l.id)) : limits, budgetMode: mode, budgetOrder: order }))(budget()), routing: routing(),
    portable:portableState(), subagents:tjCache.subagents ? {counts:tjCache.subagents.counts,hint:tjCache.subagents.hint} : null,
    setupCfg: sv, provRows: sv ? provRows.filter((v) => !sv.hiddenProviders.includes(v.provider)) : provRows,
    approvalCounts: (() => { try { return approvals().projects; } catch { return []; } })(), pagesPort,
    statusDigest: base.projects ? statusDigest(base) : null,
    setup: setupState(), // blank "Set up" cards for missing private data (SETUP.md)
    goalsContext: (() => { try { return JSON.parse(fs.readFileSync(GOALS_CTX, 'utf8')); } catch { return null; } })(),
    goalsReview: (() => { try { if (!setupState().goals) return null; return JSON.parse(fs.readFileSync(`${DATA}/goals-review.json`, 'utf8')); } catch { return null; } })(), // Goals tab (2026-11-10)
    priorities: (() => { try { return priorities(); } catch { return { projects: {}, tiers: {} }; } })(),
    // prorated over the range's whole days, capped at one month, as the cards compare it
    subProrated: Object.fromEntries(Object.keys(SUB_PRICE).map((k) => [k, subProrated(k, hi - Math.min(30, days) * 86400e3, hi)])),
    range: { from: f.from, to: f.to, bucketMs, excl: [...f.excl], days },
    rangeSpend: byProvider.deepseek?.cost || 0,
    billed: (() => {
      const b = billed.rows.filter((r) => f.inRange(r.t));
      if (!b.length) return null;
      const sum = (w) => b.filter((r) => !w || r.wallet === w).reduce((n, r) => n + r.cost, 0);
      return { total: sum(), paid: sum('Paid'), granted: sum('Granted'), through: Math.max(...b.map((r) => r.t)) };
    })(),
    counts: {
      active: active.length,
      byRole: active.reduce((m, j) => ((m[j.role] = (m[j.role] || 0) + 1), m), {}),
      jobsTotal: inRange.length,
    },
    byClass, byProvider, series, spendSeries, value: valueSummary(rs, f),
    others: (() => { try { return others.view(f); } catch (e) { console.error('other projects view failed', e); return null; } })(),
    agents: inRange.slice(0, 300).map((j) => ({ project: j.project, role: j.role, task: j.task, step: j.step, kind: j.kind, provider: provOf(j),
      class: j.classified && !CLASS[provOf(j)] ? j.classified.class : recClass({ provider: provOf(j), model: j.model }), active: j.active, rc: j.rc,
      model: j.model, slot: j.slot, skip: j.skip, started: j.started, ended: j.ended, lastMsg: j.lastMsg, tokens: j.tokens, cost: j.cost || j.estCost || 0, calls: j.calls,
      // rule: a finished paid job with no usage record is "not captured", never $0
      costState: costState(j), queueWaitMin: j.queueWaitMin, provWaitMin: j.provWaitMin })),
  };
}

// ---------- http ----------
let base = scan();
agyPriceRefresh(); setInterval(agyPriceRefresh, 24 * 3600e3); // Antigravity live prices, daily
// CPU fix 2026-11-13: 30 s while a dashboard is open (pushes stay every 15 s), 60 s when nobody watches
let lastScan = Date.now();
setInterval(() => { if (Date.now() - lastScan < (clients.size ? 28000 : 58000)) return; lastScan = Date.now(); try { base = scan(); } catch (e) { console.error('scan failed', e); } }, 15000); // 15 s (was 5 s): desktop load
// sub-item tidy: every 30 min, and once a minute after start, finished sub-items are archived in
// data/subitems-archived.json (pure code, no AI call); the dashboard reads it from the snapshot and folds them away
const archiveJob = () => { try { archiveRun({ groups: groupsOf(base), plans: base.projects || [] }); } catch (e) { console.error('[subitems-archive] failed:', e.message); } };
setTimeout(archiveJob, 60e3); setInterval(archiveJob, 30 * 60e3);

// Approvals & next steps pages: every plan past p1 gets NN-slug/approvals.html, built by
// .claude/skills/plan-status-page/page.mjs in the plan's own theme from the same items as /api/approvals.
// Rebuilt one at a time when a source (PLAN.md, index.html, DEFERRED.md, VERIFY.md, done marks, watcher asks)
// is newer than the page or the plan's stage/history changed. Hand-built pages (no generator meta) are skipped by page.mjs.
const PAGE_MJS = has(`${PLANS}/.claude/skills/plan-status-page/page.mjs`) ? `${PLANS}/.claude/skills/plan-status-page/page.mjs` : `${HERE}/../skills/plan-status-page/page.mjs`;
const apSeen = {};
let apBusy = false;
async function apRefresh() {
  if (DEV || apBusy || !fs.existsSync(PAGE_MJS)) return; // dev copy: never writes plan pages
  apBusy = true;
  try {
    const { sourcesMtime, GEN_META } = await import(new URL('./build.mjs', 'file://' + PAGE_MJS).href);
    const skip = readText(`${PLANS}/.claude/skills/plan-status-page/skip.txt`).split('\n');
    const st = (() => { try { return JSON.parse(readText(`${RUN}/state.json`)).projects || {}; } catch { return {}; } })();
    for (const dir of (fs.existsSync(PLANS) ? fs.readdirSync(PLANS) : []).filter((d) => /^\d\d-[\w.-]+$/.test(d)).sort()) {
      const p = st[dir];
      if (skip.includes(dir) || !p || p.stage === 'p1' || !fs.existsSync(`${PLANS}/${dir}/index.html`)) continue;
      const out = `${PLANS}/${dir}/approvals.html`, page = readText(out);
      if (page && !page.includes(GEN_META)) continue;
      const sig = `${p.stage}|${(p.history || []).length}`;
      let pageT = 0; try { pageT = fs.statSync(out).mtimeMs; } catch {}
      if (page && apSeen[dir] === sig && sourcesMtime(PLANS, dir) <= pageT) continue;
      await new Promise((ok) => execFile(process.execPath, [PAGE_MJS, 'build', dir], { timeout: 60000 }, (err, so) => {
        if (err) console.error(`approvals page ${dir}: ${String(err.message).slice(0, 200)}`);
        else if (/"wrote"/.test(so)) console.log(`approvals page rebuilt: ${dir}`);
        apSeen[dir] = sig; ok();
      }));
    }
  } catch (e) { console.error('approvals pages', e); } finally { apBusy = false; }
}
setTimeout(apRefresh, 15000);
setInterval(apRefresh, 60000);
const clients = new Map(); // response -> filter
const send = (res, f, memo) => { try { const k = `${f.from}|${f.to}|${[...f.excl].sort()}`; let s = memo?.get(k); if (s == null) { s = `data: ${JSON.stringify(view(base, f))}\n\n`; memo?.set(k, s); } res.write(s); } catch (e) { console.error('view failed', e); } };
setInterval(() => { const memo = new Map(); for (const [res, f] of clients) send(res, f, memo); }, 15000); // CPU fix 2026-11-13: one view per distinct filter per tick // 15 s (was 5 s): each push is ~220 KB and redraws every panel

// Control page (plan 55 control): lazy, guarded mount; the dashboard runs exactly as before if the module throws
let control = null;
// DNS-rebinding guard (2026-11-13 audit): one Host check in front of EVERY page and API route, so a route
// family added later cannot forget it (the Skill Editor routes had none). Loopback names on this port, plus a
// tailnet host the owner configured (control.json remote.host) or a proxy in AGENTGLIM_ALLOWED_HOSTS.
const guardHost = makeHostGuard({ port: () => PORT, extraNames: () => [...envExtraHosts(), ...hostAliases(DATA), ...fileExtraHosts(DATA)()] });
const dashboard = http.createServer(async (req, res) => {
  if (!guardHost(req, res)) return;
  const route = req.url.split('?')[0];
  if (route === '/api/prefs') return prefsRoute(req, res);
  if (route === '/theme.js' || route === '/theme.css') {
    res.writeHead(200, { 'content-type': route.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(readText(`${HERE}${route}`));
  }
  if (await portableRoute(req,res,route)) return;
  // popup + banner (an ES module) and its one rule, agent-notice.mjs; no-cache so a fix reaches open browsers on reload
  if (route === '/portable-ui.js' || route === '/agent-notice.mjs') { res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-cache'}); return res.end(readText(`${HERE}${route}`)); }
  if (route === '/update-notice.js' || route === '/update-notice.css') { res.writeHead(200, { 'content-type': `${route.endsWith('.css') ? 'text/css' : 'text/javascript'}; charset=utf-8`, 'cache-control': 'no-cache' }); return res.end(readText(`${HERE}${route}`)); }
  // Skill Editor (bundled sub-app): skills.html stays as the read-only inventory at /skills/inventory.
  const withShortcuts = (page) => page.includes('/shortcuts.js') ? page : page.replace('</body>', '<script src="/shortcuts.js" defer></script></body>');
  if (route === '/skills' || route === '/skills.html') { res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'}); return res.end(withShortcuts(readText(`${HERE}/skill-editor.html`))); }
  if (route === '/skills/inventory') { res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return res.end(readText(`${HERE}/skills.html`)); }
  if (route === '/skills/retire') { res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'}); return res.end(withShortcuts(readText(`${HERE}/skills-retire.html`))); }
  if (route === '/api/skills/retire') { retireRoute(req, res, route).catch((e) => { console.error('skills retire api failed', e); if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"skills retire api failed"}'); } }); return; }
  // Skill auto-grouping (before the generic /api/skills/* branch, which would swallow it): same-origin JSON only.
  if (route.startsWith('/api/skills/groups')) { skillGroupsRoute(req, res, route).catch((e) => { console.error('skills groups api failed', e); if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"skills groups api failed"}'); } }); return; }
  if (route.startsWith('/api/skills/')) { skillEditorRoute(req, res, route).catch((e) => { console.error('skills api failed', e); if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"skills api failed"}'); } }); return; }
  if (route === '/dependencies') { res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return res.end(readText(`${HERE}/../docs/dependencies.html`)); }
  if (route === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (devBlocked(route, req.method)) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":"dev copy: writes are off"}'); }
  // Containers card (v3): read-only fleet snapshot, GET only, no subprocess.
  if (route === '/api/fleet') return fleetRoute(req, res);
  if (route === '/api/build' && req.method === 'GET') { // the dashboard compares this and reloads when the page code changes
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ build: pageBuildId(), started: SELF_STARTED, now: Date.now() })); // server start, not the plan run
  }
  if (route === '/api/version' && req.method === 'GET') { // newer public release: cached, no user data sent
    refreshUpdate();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(currentUpdateStatus()));
  }
  if (route === '/api/local' && req.method === 'GET') { const j = await localStatus(RUN); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(j)); }
  if (route === '/api/local-model' && req.method === 'POST') { let b = ''; for await (const c of req) b += c; let m; try { m = JSON.parse(b).model; } catch {} const j = localSwitch(RUN, m); res.writeHead(j.ok ? 202 : 400, { 'content-type': 'application/json' }); return res.end(JSON.stringify(j)); }
  // Antigravity benchmark card: _run/bin/agy-bench.mjs, read fresh on every call
  if (route === '/api/agy-bench' && req.method === 'GET') {
    if (!has(`${RUN}/bin/agy-bench.mjs`)) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(emptyAgyBench())); }
    agyBench().then((B) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(B.summary())); })
      .catch((e) => { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); });
    return;
  }
  if (route === '/api/agy-override' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => agyBench().then((B) => { let m = null; try { m = JSON.parse(body || '{}').model || null; } catch {}
      const v = B.setOverride(m); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ override: v })); })
      .catch((e) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })); }));
    return;
  }
  // the one write a plan page may make: The owner's choice on an approval item from an approvals page.
  // Only from the plan-pages origin, only known items, only the fixed CHOICES values (decisions: an option slug), note <= 500 chars.
  // Sent as text/plain so the browser needs no preflight.
  if (route === '/api/approval-choice') {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const pagesOrigin = `http://${host}:${pagesPort}`;
    if (req.headers.origin !== pagesOrigin) { res.writeHead(403); return res.end('origin'); }
    const cors = { 'access-control-allow-origin': pagesOrigin, vary: 'origin', 'content-type': 'application/json' };
    if (req.method !== 'POST') { res.writeHead(405, cors); return res.end('{}'); }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body); } catch { b = {}; }
      const r = typeof b.id === 'string' && b.id.length < 200 && typeof (b.choice ?? '') === 'string' ? setChoice(b.id, b.choice || '', b.note, b.set, b.label) : null;
      if (!r) { res.writeHead(422, cors); return res.end('{"error":"unknown item or choice"}'); }
      res.writeHead(200, cors); res.end(JSON.stringify({ id: b.id, ...r }));
    });
    return;
  }
  // Read marks for report pages (/page-update skill): pages on localhost:8000 POST { page, read: [titles] };
  // Only from the :8000 page server (or the plan-pages port), sent as text/plain so there is no preflight;
  // stored in data/page-read.json keyed by page path, so the page's builder folds read items on the next update.
  if (route === '/api/page-read') {
    const o = req.headers.origin || '', okO = /^http:\/\/(localhost|127\.0\.0\.1):8000$/.test(o) || o === `http://${String(req.headers.host || '').replace(/:\d+$/, '')}:${pagesPort}`;
    if (o && !okO) { res.writeHead(403); return res.end('origin'); }
    const H = { 'content-type': 'application/json', ...(okO ? { 'access-control-allow-origin': o, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' } : {}) };
    const F = `${DATA}/page-read.json`, load = () => { try { return JSON.parse(fs.readFileSync(F, 'utf8')); } catch { return {}; } };
    if (req.method === 'OPTIONS') { res.writeHead(204, H); return res.end(); }
    if (req.method === 'GET') { const pg = new URL(req.url, 'http://x').searchParams.get('page') || ''; res.writeHead(200, H); return res.end(JSON.stringify(load()[pg] || { read: [] })); }
    if (req.method === 'POST') {
      let body = ''; req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
      req.on('end', () => {
        let b; try { b = JSON.parse(body); } catch { b = {}; }
        if (typeof b.page !== 'string' || !/^[\w./-]{1,200}$/.test(b.page) || !Array.isArray(b.read) || b.read.some((t) => typeof t !== 'string' || t.length > 300)) { res.writeHead(422, H); return res.end('{"error":"page and read[] required"}'); }
        const all = load(); all[b.page] = { read: [...new Set(b.read)].slice(0, 500), at: new Date().toISOString() };
        try { fs.writeFileSync(F, JSON.stringify(all, null, 1)); } catch { res.writeHead(500, H); return res.end('{"error":"write failed"}'); }
        res.writeHead(200, H); res.end(JSON.stringify(all[b.page]));
      });
      return;
    }
  }
  // write endpoints answer only this page: a plan page (port PORT+1) or any other site gets 403
  if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); return res.end('cross-origin'); }
  if (control && (route === '/control' || route.startsWith('/control/') || route.startsWith('/api/control/'))) return control.handle(req, res, route); // plan 55 control
  if (route === '/api/speed' && req.method === 'POST') { // old speed buttons: now a watcher request <sub>.speed (HARNESS 3.6, 2026-11-01)
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', () => { let b; try { b = JSON.parse(body); } catch { b = {}; } const id = b.id === 'go2' ? 'go' : b.id;
      if (!['go', 'codex', 'claude'].includes(id) || !['slow', 'normal', 'fast'].includes(b.level)) { res.writeHead(422); return res.end('{"error":"id or level"}'); }
      modeRequest(`${id}.speed`, b.level, null, (code, msg) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ queued: code === 200, msg })); }); });
    return;
  }
  if (route === '/api/job-report') { // tracked job's report: its last message or outdir output, as text
    const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
    const rec = /^[A-Za-z0-9_.-]{1,80}$/.test(id) ? readTracked(TJ_DIR).find((j) => j.id === id) : null;
    const txt = jobReport(rec);
    res.writeHead(txt ? 200 : 404, { 'content-type': 'text/plain; charset=utf-8' }); res.end(txt || 'no report for this job'); return;
  }
  if (route === '/api/open-url' && req.method === 'POST') { // Agentglim app window: open plan/approval pages in the default browser
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => { let u = ''; try { u = String(JSON.parse(body).url || ''); } catch {}
      if (!sameAppRequest(req.headers)) { res.writeHead(403); return res.end('{"error":"origin"}'); }
      u = normalizeOpenUrl(u); if (!u) { res.writeHead(422); return res.end('{"error":"url"}'); }
      const c = spawn('xdg-open', [u], { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref();
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    return;
  }
  if (route === '/api/priority' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 512) req.destroy(); });
    req.on('end', () => { let b; try { b = JSON.parse(body); } catch { b = {}; }
      if (!/^\d\d-[a-z0-9-]+$/.test(b.dir || '') || !fs.existsSync(path.join(PLANS, b.dir)) || ![1, 2, 3].includes(b.tier)) { res.writeHead(422); return res.end('{"error":"dir or tier"}'); }
      try { const f = path.join(DATA, 'priorities.json'); const data = JSON.parse(fs.readFileSync(f, 'utf8')); data.projects ||= {}; data.projects[b.dir] = { ...data.projects[b.dir], tier: b.tier }; fs.writeFileSync(f, JSON.stringify(data, null, 2) + '\n'); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ dir: b.dir, tier: b.tier })); } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); } });
    return;
  }
  if (route === '/api/hold' && req.method === 'POST') { // pipeline hold/unhold button: HOLD file on, or moved to _run/flags/old (never deleted)
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 512) req.destroy(); });
    req.on('end', () => { let b; try { b = JSON.parse(body); } catch { b = {}; }
      const dir = String(b.dir || ''), f = `${PLANS}/${dir}/HOLD`;
      if (!/^\d\d-[a-z0-9-]+$/.test(dir) || !exists(`${PLANS}/${dir}`)) { res.writeHead(422); return res.end('{"error":"dir"}'); }
      try {
        if (b.hold) { if (!exists(f)) fs.writeFileSync(f, `owner hold from the Observatory ${new Date().toLocaleString('sv-SE')}\n`); }
        else if (exists(f)) { fs.mkdirSync(`${RUN}/flags/old`, { recursive: true }); fs.renameSync(f, `${RUN}/flags/old/HOLD-${dir}-${Date.now()}`); }
        fs.appendFileSync(`${RUN}/driver.log`, `${new Date().toLocaleString('sv-SE')} observatory: ${dir} ${b.hold ? 'HOLD on' : 'HOLD off'} (owner button)\n`);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ dir, held: exists(f) }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); } });
    return;
  }
  // category pause key (Pipeline card): GET answers status() per category ([] without the harness module, so no buttons);
  // POST {cat, pause: true|false} runs pause(cat) / resume(cat). Same-origin like /api/hold (the cross-origin guard above); off in the dev copy.
  if (route === '/api/category-holds' && req.method === 'GET') {
    const J = { 'content-type': 'application/json', 'cache-control': 'no-store' };
    try { const m = await categoryHold(); res.writeHead(200, J); return res.end(JSON.stringify(m ? m.status(CAT_OPTS) : [])); }
    catch (e) { res.writeHead(500, J); return res.end(JSON.stringify({ error: String(e.message || e) })); }
  }
  if (route === '/api/category-hold' && req.method === 'POST') {
    const J = { 'content-type': 'application/json' };
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 512) req.destroy(); });
    req.on('end', async () => { let b; try { b = JSON.parse(body); } catch { b = {}; }
      if (typeof b.cat !== 'string' || !/^[A-Za-z][A-Za-z0-9 _-]{0,39}$/.test(b.cat) || typeof b.pause !== 'boolean') { res.writeHead(422, J); return res.end('{"error":"cat (a category name) and pause (true or false) required"}'); }
      try {
        const m = await categoryHold();
        if (!m) { res.writeHead(404, J); return res.end('{"error":"this harness has no _run/bin/category-hold.mjs"}'); }
        const r = b.pause ? m.pause(b.cat, { ...CAT_OPTS, by: 'owner via AgentGlim' }) : m.resume(b.cat, CAT_OPTS);
        try { base = scan(); } catch {} // the rows' HOLD lines show on the next push
        res.writeHead(200, J); res.end(JSON.stringify(r));
      } catch (e) { res.writeHead(/unknown category/.test(e.message) ? 422 : 500, J); res.end(JSON.stringify({ error: String(e.message || e) })); } });
    return;
  }
  if (route === '/api/role-models') {
    const reply = (code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (!['GET', 'POST'].includes(req.method)) return reply(405, { error: 'Use GET or POST' });
    if (req.method === 'POST' && !sameAppRequest(req.headers)) return reply(403, { error: 'Same-origin request required' });
    let value;
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 16384) return reply(413, { error: 'Role grid is too large' }); }
      try { value = JSON.parse(body); } catch { return reply(422, { error: 'Invalid JSON' }); }
    }
    try { return reply(200, await roleModelsView({ plansDir: PLANS, runDir: RUN }, value)); }
    catch (e) { return reply(req.method === 'POST' && !e.code ? 422 : 500, { error: e.message }); }
  }
  if (route === '/api/mode' && req.method === 'POST') { // Status card mode clicks: queue a request; the watcher applies it (modes.mjs apply-queue)
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', () => { let b; try { b = JSON.parse(body); } catch { b = {}; }
      if (!/^(harness|reaper|cloud|api|codexApi|cloudSlots|cloudFloorUsd|apiStopUsd|codexApiStopUsd|(claude|codex|go)\.(mode|speed|plans)|(claude|codex|go)\.(limit|gate|wgate)\.[a-z_]{2,20}|(claude|codex)\.(weekly|finalAudit)|gates\.[A-Za-z0-9]{2,30})$/.test(b.key || '') || !/^([a-z]{2,10}|\d{1,3})$/.test(String(b.value ?? '')) || (b.until && !/^\d{4}-\d\d-\d\dT[\d:.+\-Z]{5,25}$/.test(b.until))) { res.writeHead(422); return res.end('{"error":"key, value or until"}'); }
      modeRequest(b.key, b.value, b.until || null, (code, msg) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ queued: code === 200, msg })); }); });
    return;
  }
  if (route === '/api/status-refresh' && req.method === 'POST') {
    try {
      // Refresh live data immediately; only the watcher may answer the queued request.
      try { syncGoals(); } catch (e) { console.error('goals sync failed', e.message); } // re-read the goals project
      await refreshClaudeUsage(true).catch(() => {}); // fresh Claude 5h/weekly for the top bar and Budget routing (2026-11-06)
      base = scan();
      let digest = buildDigest(base);
      const status = liveStatus(digest, { stop: readText(`${RUN}/STOP`), modes: (() => { try { return JSON.parse(readText(`${RUN}/modes.json`)) || {}; } catch { return {}; } })() }); // modes.json is optional: absent on a fresh install
      const target = `${DATA}/status.json`;
      let previous = {}; try { previous = JSON.parse(readText(target)); } catch {}
      const out = { ...previous, ...status, history: [...(previous.history || []), { at: status.at, running: digest.tally.running }].slice(-48) };
      if (previous.source !== 'live') out.lastWatcherAnswer = { at: previous.linesAt, lines: previous.lines };
      fs.writeFileSync(`${target}.next`, JSON.stringify(out, null, 2) + '\n');
      fs.renameSync(`${target}.next`, target);
      fs.mkdirSync(ASK_DIR, { recursive: true });
      // Exclusive creation preserves separate clicks even within the same millisecond.
      let askAt = Date.now();
      while (true) {
        try {
          fs.writeFileSync(`${ASK_DIR}/${askAt}.json`, JSON.stringify({ at: askAt, source: 'status-refresh', message: 'Owner requests SuperAgent health check and Status update.' }) + '\n', { flag: 'wx' });
          break;
        } catch (e) { if (e.code !== 'EEXIST') throw e; askAt++; }
      }
      // same full refresh as the owner typing "status" (one script); the ask stays for the SuperAgent
      if (has(`${RUN}/bin/status-refresh.sh`)) { const c = spawn('bash', [`${RUN}/bin/status-refresh.sh`, '--keep-asks'], { detached: true, stdio: ['ignore', fs.openSync(`${RUN}/logs/status-refresh.log`, 'a'), fs.openSync(`${RUN}/logs/status-refresh.log`, 'a')] }); c.on('error', () => {}); c.unref(); }
      digest = { ...digest, at: Date.now(), watcher: watcherSaid(), deep: { ...digest.deep, watcher: watcherDeep() } };
      digestCache = digest;
      fs.writeFileSync(DIGEST_FILE, JSON.stringify(digestCache));
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ at: digest.at, ask: statusAsk(), statusDigest: digest }));
    } catch (e) {
      console.error('status refresh failed', e);
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Status refresh failed. Please retry.' }));
    }
  }
  if (route === '/api/status-ask' && req.method === 'GET') { // the page polls this after "refresh now"; once answered, the digest is rebuilt so "the watcher said" shows the new lines
    const ask = statusAsk(); if (ask?.answeredAt && (!digestCache || digestCache.at < ask.answeredAt)) { try { digestCache = buildDigest(base); fs.writeFileSync(DIGEST_FILE, JSON.stringify(digestCache)); } catch (e) { console.error('status digest failed', e); } }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ ask, digestAt: digestCache?.at || null }));
  }
  if (route === '/api/modes' && req.method === 'GET') { if (!has(MODES_MJS)) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(emptyModes())); } modesRun(['show', '--json'], (err, so) => { res.writeHead(err ? 500 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(err ? JSON.stringify({ error: String(err.message || err) }) : so); }); return; }
  if (route === '/api/owner-claim' && req.method === 'POST') { // Status card "done": stays open until the watcher checks it
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => { let b; try { b = JSON.parse(body); } catch { b = {}; }
      const it = typeof b.id === 'string' ? approvals(0).items.find((i) => i.id === b.id && !i.done) : null;
      const r = it ? (b.undo ? unclaim(it.id) : claim(it, b.note)) : null;
      if (r) try { digestCache = buildDigest(base); fs.writeFileSync(DIGEST_FILE, JSON.stringify(digestCache)); } catch (e) { console.error('status digest failed', e); }
      res.writeHead(r ? 200 : 422, { 'content-type': 'application/json' }); res.end(JSON.stringify(r ? { id: b.id, ...r } : { error: 'unknown or closed item' })); });
    return;
  }
  if (route === '/api/approvals/send' && req.method === 'GET') {
    const r = sendStatus(new URL(req.url, 'http://x').searchParams.get('id'), null, sendConfig(process.env, { data: DATA, plans: PLANS, run: RUN_DIR }));
    res.writeHead(r ? 200 : 404, { 'content-type': 'application/json' }); return res.end(JSON.stringify(r || { error: 'unknown delivery' }));
  }
  if (route === '/api/approvals/send' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      let b; try { b = JSON.parse(body); } catch { b = {}; }
      let r; try { r = await sendToAgent({ text: b.text, source: b.source }, sendConfig(process.env, { data: DATA, plans: PLANS, run: RUN_DIR })); } catch (e) { r = { state: 'failed', fallback: 'copy', reason: String(e.message || e) }; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r));
    });
    return;
  }
  if (route === '/api/approvals' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(approvals())); }
  if (route === '/api/approvals' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body); } catch { b = {}; }
      const r = typeof b.id === 'string' && b.id.length < 200 ? markDone(b.id, !!b.done, b.note) : null;
      if (!r) { res.writeHead(422, { 'content-type': 'application/json' }); return res.end('{"error":"unknown item"}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: b.id, ...r }));
    });
    return;
  }
  if (route === '/api/snapshot') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(view(base, parseFilter(req.url)))); }
  if (route === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const f = parseFilter(req.url);
    send(res, f);
    clients.set(res, f); req.on('close', () => clients.delete(res));
    return;
  }
  if (route === '/api/review-reject' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body); } catch { b = {}; }
      if (typeof b.key !== 'string' || !/^[^|]{1,80}\|.{1,120}$/.test(b.key)) { res.writeHead(422, { 'content-type': 'application/json' }); return res.end('{"error":"key required"}'); }
      let r; try { r = rejectItem(b.key, typeof b.note === 'string' ? b.note.slice(0, 500) : ''); } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: String(e.message || e) })); }
      try { base = scan(); } catch {}
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, dir: r.dir }));
    });
    return;
  }
  if (route === '/api/classes' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body); } catch { b = {}; }
      const ok = typeof b.key === 'string' && /^[^|]{1,80}\|.{1,120}$/.test(b.key) && /^[a-z0-9.-]{1,30}$/.test(b.provider || '') && CLASSES.includes(b.class);
      if (!ok) { res.writeHead(422, { 'content-type': 'application/json' }); return res.end('{"error":"key, provider and class required"}'); }
      const [kind, model] = b.key.split('|');
      const c = classify(kind, model === '?' ? null : model);
      const saved = approve(b.key, { kind, model: model === '?' ? null : model, provider: b.provider, class: b.class,
        source: b.provider === c.provider && b.class === c.class ? c.source : 'manual', price: c.price || null });
      try { base = scan(); } catch {}
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(saved));
    });
    return;
  }
  if (route === '/api/prices' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      let b; try { b = JSON.parse(body); } catch { b = {}; }
      const prop = loadProposals()[b.model];
      if (!prop || !['accept', 'keep'].includes(b.action) || (b.action === 'accept' && !prop.seen)) {
        res.writeHead(422, { 'content-type': 'application/json' }); return res.end('{"error":"unknown proposal or action"}');
      }
      // accept: the page's stated fields over the recorded ones (a field the page didn't state keeps its value)
      const price = b.action === 'accept' ? { ...prop.current, ...prop.seen } : prop.current;
      const r = await setPriceAsync(b.model, price);
      if (r.status !== 0) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: r.stderr.slice(-300) })); }
      dropProposal(b.model);
      try { base = scan(); } catch {}
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ model: b.model, price }));
    });
    return;
  }
  if (route === '/api/other-projects') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(others.view(parseFilter(req.url)))); }
  if (route === '/api/history') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    return res.end(readText(`${DATA}/history.ndjson`).split('\n').slice(-1500).join('\n'));
  }
  { const wt = /^\/walkthrough(-steps)?\.(js|css|json)$/.exec(route); if (wt && (wt[1] ? wt[2] === 'json' : wt[2] !== 'json')) { res.writeHead(200, { 'content-type': { js: 'text/javascript', css: 'text/css', json: 'application/json' }[wt[2]] + '; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(readText(`${HERE}${route}`)); } } // first-run tour (walkthrough feature)
  if (route === '/app-links.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(readText(`${HERE}/app-links.js`)); }
  if (route === '/plan-icons.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(readText(`${HERE}/plan-icons.js`)); }
  if (route === PROCESS_GUARD_ROUTE) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(readText(`${HERE}/process-guard.html`)); }
  if (route === '/model-icons.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(readText(`${HERE}/model-icons.js`)); }
  if (route === '/goals-page' || route === '/goals' || route === '/goals.html') { // full goals view: the sub-app at /goals renders the same JSON live
    // A page built into $AGENTGLIM_GOALS by scripts/build_goals_page.mjs wins; otherwise serve the bundled
    // live page (app/goals-app.html). GitHub issue #1: a fresh install fell to "goals.html not built yet"
    // although the repo ships a working goals page, so /goals-page names that broken state no more.
    const t = readText(`${GOALS}/goals.html`) || readText(`${HERE}/goals-app.html`);
    res.writeHead(t ? 200 : 500, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(t || 'goals page missing from this install: reinstall AgentGlim'); }
  if (route === '/goals-app.mjs' || route === '/goals-app.css' || route === '/shortcuts.js') {
    res.writeHead(200, { 'content-type': `${route.endsWith('.css') ? 'text/css' : 'text/javascript'}; charset=utf-8`, 'cache-control': 'no-cache' });
    return res.end(readText(`${HERE}${route}`));
  }
  // Goals sub-app JSON (plan 1). Read-only except the owner refresh and the weekly queue; both are same-origin POSTs.
  if (route.startsWith('/api/goals/')) {
    const u = new URL(req.url, 'http://localhost'), demo = u.searchParams.get('demo') === '1';
    const planPages = () => process.env.AGENTGLIM_PLAN_PAGES_URL || `http://127.0.0.1:${pagesPort}`;
    const J = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    const publicOverview = (ov) => {
      const sched = goalsJobsStatus(), next = ov.freshness.nextRefreshAt || sched.jobs.find((j) => j.name === 'goals-refresh')?.nextRun || null;
      return {
        ...ov, planPagesUrl: planPages(), weekly: weeklyStatus(),
        goals: ov.goals.map(({ asks, ...g }) => ({ ...g, asks: { open: asks.open, needYou: asks.needYou, projects: asks.projects.map(({ asks: _a, ...p }) => p) } })),
        freshness: { ...ov.freshness, nextRefreshAt: next, scheduler: sched },
      };
    };
    try {
      if (route === '/api/goals/overview' && req.method === 'GET') return J(200, publicOverview(await getOverview({ demo })));
      if (route === '/api/goals/asks' && req.method === 'GET') {
        const ov = await getOverview({ demo }), goal = ov.goals.find((g) => g.id === u.searchParams.get('goal'));
        if (!goal) return J(404, { error: { message: 'Unknown goal id.' } });
        return J(200, { goal: { ...goal, asks: { open: goal.asks.open, needYou: goal.asks.needYou, projects: [] } }, projects: goal.asks.projects });
      }
      if (route === '/api/goals/week' && req.method === 'GET') {
        const ov = await getOverview({ demo });
        return J(200, { reviewDate: ov.reviewDate, priorities: ov.priorities, news: ov.news, week: ov.week, drift: ov.drift, gaps: ov.gaps, experiment: ov.experiment });
      }
      if (route === '/api/goals/rules' && req.method === 'GET') return J(200, { files: (await getOverview({ demo })).rules });
      if (route === '/api/goals/status' && req.method === 'GET') {
        const ov = await getOverview({ demo });
        return J(200, { freshness: ov.freshness, scheduler: goalsJobsStatus(), weekly: weeklyStatus() });
      }
      if (route === '/api/goals/refresh' && req.method === 'POST') {
        if (!sameAppRequest(req.headers)) return J(403, { error: { message: 'same-origin POST only' } });
        try { const data = await runRefresh({ demo, dev: DEV, reason: 'owner button' }); return J(200, { ok: true, demo: data.demo, goals: data.goals.length, refresh: data.refresh }); }
        catch (e) { if (!demo) { try { (await import('./goals-report.mjs')).markRefreshFailure(e); } catch {} } return J(500, { error: errorShape(e) }); }
      }
      if (route === '/api/goals/weekly-review' && req.method === 'POST') {
        if (!sameAppRequest(req.headers)) return J(403, { error: { message: 'same-origin POST only' } });
        let body = ''; for await (const c of req) { body += c; if (body.length > 4096) { req.destroy(); break; } }
        const r = queueWeeklyReview({ reason: 'owner button', demo });
        return J(r.queued ? 200 : 422, r);
      }
      return J(404, { error: { message: 'unknown goals route' } });
    } catch (e) { return J(422, { error: errorShape(e) }); }
  }
  // Setup page (2026-11-11): pick your harnesses, plans, free API keys, local models and custom projects (setup.mjs)
  if (route === '/setup' || route === '/setup.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(readText(`${HERE}/setup.html`)); }
  if (route === '/api/setup/jev' || route === '/api/setup/jev/test') return jevSetupEndpoint(req, res, route);
  if (route === '/api/setup' && req.method === 'GET') { const d = setupDetect(); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ config: loadSetup(d), detected: d, paths: pathsInfo(), catalog: setupCatalog(), credentialStatus:Object.fromEntries(Object.values(loadSetup(d).subs).flatMap(s => s.entries || []).map(e => [e.credential,credentialSet(e.credential)])), envFile: ENV_FILE.replace(HOME, '~') })); }
  if (route === '/api/setup' && req.method === 'POST') { if (!sameAppRequest(req.headers) || req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); return res.end(); } let b = ''; for await (const c of req) { b += c; if (b.length > 65536) { res.writeHead(413); return res.end(); } }
    let j; try { j = JSON.parse(b); } catch { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"bad json"}'); }
    try { const out = saveSetup(j, { complete: false }); const sc = await new Promise((r) => runScaffold(r));
      if (sc.ok) { completeSetup(); out.setupComplete = true; }
      res.writeHead(200, { 'content-type': 'application/json' });
      // saved = your choices are on disk; ready = the SuperAgent tools are linked too. Never report one as the other.
      const pi = pathsInfo();
      return res.end(JSON.stringify({ ok: !!sc.ok, saved: true, ready: !!sc.ok, config: out, scaffold: sc, paths: pi, restartNeeded: pi.restartNeeded, ...(sc.ok ? {} : { error: `Settings saved, but linking the SuperAgent tools failed: ${sc.output || 'no output'}` }) })); }
    catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: String(e.message || e) })); } }
  // Harness page (2026-11-06): read-only view of the plans harness pieces, lanes, Jev rules, disk guard, local model,
  // watcher queues and skills (harness.mjs, ../harness/manifest.json). Lazy import: a fault there never stops the dashboard.
  if (route === '/harness' || route === '/harness.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(readText(`${HERE}/harness.html`)); }
  // "Link tools" button on the Harness page: same step as scaffold-harness (issue #1)
  if (route === '/api/harness-scaffold' && req.method === 'POST') {
    if (!sameAppRequest(req.headers) || req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403); return res.end(); }
    return runScaffold((r) => { res.writeHead(r.ok ? 200 : 500, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); });
  }
  // Harness page edits: queue a jev.* change through modes.mjs request; the watcher applies it (apply-queue)
  if (route === '/api/harness-setting' && req.method === 'POST') {
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', () => { let b; try { b = JSON.parse(body); } catch { b = {}; }
      const value = String(b.value ?? '');
      if (!['jev.close', 'jev.notifyPicks'].includes(b.key) || !/^[a-z0-9.,-]{0,300}$/.test(value)) { res.writeHead(422, { 'content-type': 'application/json' }); return res.end('{"error":"key or value"}'); }
      modesRun(['request', b.key, value || 'none', '--by', 'harness page'], (err, so, se) => { const code = err ? (err.code === 2 ? 422 : 500) : 200;
        res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ queued: code === 200, msg: (so || se).trim() })); }); });
    return;
  }
  if (route === '/api/harness' && req.method === 'GET') {
    try { const { harnessView } = await import('./harness.mjs'); const j = harnessView(); res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(j)); }
    catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: String(e.message || e) })); }
  }
  if (route === '/roles' || route === '/roles.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(readText(`${HERE}/roles.html`)); }
  if (route === '/routing' || route === '/routing.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); return res.end(readText(`${HERE}/routing.html`)); }
  if (route === '/api/routing' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); return res.end(JSON.stringify(routingView())); }
  if (route === '/api/routing-feedback' && req.method === 'POST') { // same-origin only: an Origin header is required and must be this page
    if (req.headers.origin !== `http://${req.headers.host}`) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end('{"error":"same-origin only"}'); }
    let body = ''; req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body); } catch { b = {}; }
      let r; try { r = saveFeedback(b); } catch (e) { r = { status: 500, error: String(e.message || e) }; }
      res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.status === 200 ? { ok: true, feedback: r.feedback, prefs: routingView().prefs } : { error: r.error }));
    });
    return;
  }
  if (route === '/reaper' || route === '/reaper.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readText(`${HERE}/reaper.html`)); }
  if (route === '/api/reaper') { // hang reaper AI verdicts: last 300 rows, evidence trimmed
    const rows = (readText(`${RUN}/flags/reaper-verdicts.ndjson`) || '').trim().split('\n').slice(-300).map((l) => { try { const r = JSON.parse(l), e = r.evidence || {}; return { at: r.at, type: r.type, pid: r.pid, comm: r.comm, cmd: r.cmd, cwd: r.cwd, age: r.age, idle: r.idle, sonnetPhase: r.sonnetPhase, action: r.action, why: r.why, jev: r.jev || null, sonnet: r.sonnet || null, jevError: r.jevError || null, sonnetError: r.sonnetError || null, ev: { state: e.state, wchan: e.wchan, cpu: e.cpuTicksDuringCheck, writer: e.stdinHasLiveWriter, stdin: e.stdin, kids: (e.children || []).length, parent: (e.ancestors?.[0]?.cmd || '').slice(0, 400) } }; } catch { return null; } }).filter(Boolean).reverse();
    let cfg = null; try { const c = JSON.parse(readText(`${RUN}/reaper-judge.json`)); cfg = { killProb: c.killProb, minConfidence: c.minConfidence, recheckSec: c.recheckSec, fallbackSec: c.fallbackSec, sonnetUntil: c.sonnetUntil, reviewedAt: c.reviewedAt }; } catch {}
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ rows, cfg, review: readText(`${RUN}/flags/reaper-review.md`) || null }));
  }
  if (route === '/api/trials') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(TRIALS.get())); } // Trials block
  { const tm = /^\/trials\/(effort|orchestrator|worker)$/.exec(route); if (tm) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(trialPage(TRIALS.get().trials.find((t) => t.id === tm[1]))); } }
  if (route === '/audit-spend' || route === '/audit-spend.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readText(`${RUN}/AUDIT-SPEND-REVIEW.html`) || 'No review yet: run _run/session-review/build_report.py'); } // 14-day session review behind the audit-share tip
  if (route === '/model-icons' || route === '/model-icons.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readText(`${HERE}/model-icons.html`)); }
  if (route === '/api/model-icons' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ store: iconStore, tiers: MI.tiers(iconStore) })); }
  // owner picks a style for a model tier: { key: "claude:opus", style: "glyph", v: "gear" } (v optional); style null clears the pick
  if (route === '/api/model-icons' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let b; try { b = JSON.parse(body); } catch { b = {}; }
      const ok = typeof b.key === 'string' && /^(claude|codex):[a-z0-9-]{1,30}$/.test(b.key) && (b.style == null || b.style === 'plain' || MI.STYLE_KEYS.includes(b.style));
      if (!ok) { res.writeHead(422, { 'content-type': 'application/json' }); return res.end('{"error":"key and style required"}'); }
      try { iconStore = MI.pick(iconStore, b.key, b.style ?? null, typeof b.v === 'string' || typeof b.v === 'number' ? b.v : null); saveIcons(); } catch (e) { const bad = /^(unknown|bad) /.test(e.message || ''); res.writeHead(bad ? 422 : 500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: String(e.message || e) })); }
      for (const [r, f] of clients) send(r, f);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ store: iconStore, tiers: MI.tiers(iconStore) }));
    });
    return;
  }
  if (route === '/' || route === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    // stamp the page with the build id of the code just served: the page reloads itself when a new one appears
    const page = integrationPage(readText(`${HERE}/index.html`)).replace('<meta name="agBuild" content="">', `<meta name="agBuild" content="${pageBuildId()}">`);
    return res.end(DEV ? page.replace(/<body([^>]*)>/, `<body$1><div id="devBadge" title="Dev copy: writes into the harness are ${DEV_WRITES ? 'ON for this test' : 'off'}" style="position:fixed;bottom:6px;right:8px;z-index:9999;background:#b45309;color:#fff;font:600 11px/1.7 system-ui,sans-serif;padding:0 7px;border-radius:5px;pointer-events:none">DEV</div>`) : stripDevOnly(page));
  }
  res.writeHead(404); res.end('not found');
});
const pagesReady = new Promise(resolve => {
  servePages(pagesPort, port => { pagesPort = port; resolve(); });
});
dashboard.listen(PORT, '127.0.0.1', async () => {
  PORT = dashboard.address().port;
  await pagesReady;
  startPortable();
  try { startInboxResend({ dev: DEV }); } catch (e) { console.error('inbox resend start failed', e.message); } // SuperAgent chat resend on the shared scheduler
  if (UPDATE_ENABLED) refreshUpdate(); // background; /api/version answers from cache meanwhile
  // Mount control after binding so its origin checks and proxy use the actual port.
  await import('./control/control.mjs').then((m) => {
    control = m.mountControl({ snapshot: () => view(base, parseFilter('/api/snapshot')), approvals, markDone, modeRequest, dataDir: DATA, plansDir: PLANS, runDir: RUN, desktopPort: PORT, ...(DEV ? { pushPoll: false } : {}) });
    if (!DEV) control.listenRemote(); // no-op unless control.json remote.enabled; the dev copy never opens the remote listener
  }).catch((e) => console.error('control module not loaded', e));
  console.log(`AgentGlim on http://localhost:${PORT} (127.0.0.1)${DEV ? `, dev copy, writes ${DEV_WRITES ? 'ON' : 'off'}` : ''}`);
});

// plans with no priority get a Jev tier (Opus review when unsure), at start and every 30 min
const prioRun = () => import('./prio-jev.mjs').then((m) => m.labelMissing()).catch((e) => console.error('prio-jev', e.message));
if (!DEV) { setTimeout(prioRun, 60e3); setInterval(prioRun, 30 * 60e3); } // dev copy: no Jev spend

// Skill auto-grouping, once a day: new or changed skills only; code first, local model through `pi` for the rest.
// AGENTGLIM_SKILL_GROUPS_JOB=1 forces it on in a dev copy; the dev copy never runs it by default (fixtures).
if (!DEV || process.env.AGENTGLIM_SKILL_GROUPS_JOB === '1') {
  registerScheduledJob('skill-groups', 24 * 60 * 60e3, () => runGrouping(), { catchUp: true });
}
