// Weekly price check for the optional configured model-price ledger.
//   node price-check.mjs           run when the last check is 7+ days old (cron calls this hourly)
//   node price-check.mjs --force   run now
// Scope: the models the plans run uses, from data/run-models.json (written by the observatory server). The ledger
// is shared with leads; its other entries are leads' to keep.
// 1. leads' tools/update_prices.py refreshes every OpenRouter-sourced price (cheapest live endpoint, old price kept
//    as "previous") and checks that OpenCode Zen free models are still served. It has no per-model option, so it
//    refreshes the whole ledger; only the run's models are reported.
// 2. Hand-set model rates become proposals for explicit review. No model calls are made.
//    Subscription prices are checked daily over plain HTTP in price-data.mjs.
// State for the dashboard: data/price-check.json { lastRun, nextDue, ok, refreshed, confirmed, proposals, errors }.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { DATA } from './paths.mjs';
import { integrations, modelPricesFile } from './integrations.mjs';
const STATE = `${DATA}/price-check.json`;
const PROPOSALS = `${DATA}/price-proposals.json`;
const RUN_MODELS = `${DATA}/run-models.json`;
const LOG = `${DATA}/price-check.log`;
export const LEADS = integrations.leadsPath;
export const LEDGER = modelPricesFile;
const UV = `${process.env.HOME}/.local/bin/uv`;
export const EVERY_DAYS = 7;
const FIELDS = ['input', 'cached_input', 'cache_write', 'output'];

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2) + '\n'); fs.renameSync(f + '.tmp', f); };
const log = (m) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);
const daysSince = (d) => d ? (Date.now() - Date.parse(d)) / 86400e3 : Infinity;

// leads' own updater; uv supplies httpx without touching the leads repo
export function updater(args) {
  if (!LEADS || !fs.existsSync(`${LEADS}/tools/update_prices.py`) || !fs.existsSync(UV)) return {status:-1,stderr:'Optional model-price updater is not installed'};
  return spawnSync(UV, ['run', '-q', '--no-project', '--with', 'httpx', 'python3', 'tools/update_prices.py', ...args],
    { cwd: LEADS, encoding: 'utf8', timeout: 600e3 });
}
// hand-set one price through the updater, so leads' bookkeeping (previous, changed_at, confirmed_at) stays its own
const setArgs = (model, p) => ['--set', model, ...FIELDS.filter((f) => p[f] != null).flatMap((f) => [`--${f.replace('_', '-')}`, String(p[f])])];
export const setPrice = (model, p) => updater(setArgs(model, p));
// same, without blocking the observatory's event loop
export const setPriceAsync = (model, p) => new Promise((resolve) => {
  if (!LEADS || !fs.existsSync(`${LEADS}/tools/update_prices.py`) || !fs.existsSync(UV)) return resolve({status:-1,stderr:'Optional model-price updater is not installed'});
  const c = spawn(UV, ['run', '-q', '--no-project', '--with', 'httpx', 'python3', 'tools/update_prices.py', ...setArgs(model, p)], { cwd: LEADS });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  c.on('error', (e) => resolve({ status: -1, stderr: String(e) }));
  c.on('close', (status) => resolve({ status, stderr: err }));
});
export const loadProposals = () => readJson(PROPOSALS, {});
export function dropProposal(model) { const p = loadProposals(); delete p[model]; writeJson(PROPOSALS, p); }
export const loadState = () => readJson(STATE, {});

// Hand-set API rates require explicit review. Pricing automation never invokes a model.
// Subscription tiers are checked daily over HTTP by price-data.mjs; the optional legacy updater
// continues refreshing machine-readable model rates. Unstructured model docs become review proposals.
function readDocs() { return {}; }

export function due() { return daysSince(readJson(STATE, {}).lastRun) >= EVERY_DAYS; }

export function run() {
  if (!LEADS) return { ok: true, skipped: true, reason: 'No model-price integration configured' };
  fs.mkdirSync(DATA, { recursive: true });
  const st = { lastRun: new Date().toISOString(), ok: true, refreshed: [], confirmed: [], proposals: 0, errors: [] };
  log('price check start');
  const runModels = readJson(RUN_MODELS, null)?.models;
  if (!runModels) { st.ok = false; st.errors.push('data/run-models.json missing: start the observatory server once, then re-run'); }
  const used = new Set(runModels || []);
  // 1. OpenRouter + Zen refresh
  const u = updater([]);
  log(`update_prices.py rc=${u.status}\n${(u.stdout || '').trim()}\n${(u.stderr || '').trim()}`);
  if (u.status !== 0) { st.ok = false; st.errors.push(`update_prices.py rc=${u.status}: ${(u.stderr || '').trim().slice(-300)}`); }
  st.refreshed = [...(u.stdout || '').matchAll(/^ {2}(\S+)\s*$/gm)].map((x) => x[1]).filter((m) => used.has(m));
  // 2. stale manual prices, grouped by pricing page
  const ledger = readJson(LEDGER, { models: {} });
  const staleAfter = Number(ledger.staleness_days) || EVERY_DAYS;
  const byUrl = {};
  for (const [model, e] of Object.entries(ledger.models)) {
    if (!used.has(model) || e.source !== 'manual' || daysSince(e.confirmed_at) < staleAfter) continue;
    (byUrl[e.source_url || ''] ||= []).push(model);
  }
  const proposals = readJson(PROPOSALS, {});
  if (runModels) for (const m of Object.keys(proposals)) if (!used.has(m)) delete proposals[m];
  for (const [url, models] of Object.entries(byUrl)) {
    let seen = {};
    if (/^https?:/.test(url)) {
      try { seen = readDocs(url, models); } catch (e) { st.errors.push(String(e.message || e)); }
    }
    for (const model of models) {
      const cur = ledger.models[model].current || {};
      const s = seen[model];
      const stated = s?.found ? FIELDS.filter((f) => typeof s[f] === 'number') : [];
      const same = stated.length > 0 && stated.every((f) => Math.abs(s[f] - (cur[f] ?? NaN)) < 1e-9);
      if (same) {
        const r = setPrice(model, cur);
        if (r.status === 0) st.confirmed.push(model); else st.errors.push(`re-confirm ${model}: ${(r.stderr || '').slice(-200)}`);
        delete proposals[model];
      } else {
        // changed, or the page could not be read: you decide on the dashboard
        proposals[model] = { model, url: url || null, current: cur, seen: s?.found ? Object.fromEntries(stated.map((f) => [f, s[f]])) : null,
          evidence: s?.evidence || null, reason: !url ? 'no pricing page on record' : !s ? 'could not read the pricing page' : !s.found ? 'model not listed on the page' : 'price differs from the ledger',
          at: st.lastRun };
      }
    }
  }
  writeJson(PROPOSALS, proposals);
  st.proposals = Object.keys(proposals).length;
  st.nextDue = new Date(Date.now() + EVERY_DAYS * 86400e3).toISOString();
  writeJson(STATE, st);
  log(`price check done: ${st.refreshed.length} refreshed, ${st.confirmed.length} re-confirmed, ${st.proposals} to review, ${st.errors.length} errors`);
  return st;
}

if (path.resolve(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url))) {
  if (process.env.AGENTGLIM_DEV === '1') process.exit(0);
  if (process.argv.includes('--subscriptions')) { const {checkPrices}=await import('./price-data.mjs'); console.log(JSON.stringify(await checkPrices({force:process.argv.includes('--force')}))); process.exit(0); }
  if (!process.argv.includes('--force') && !due()) process.exit(0);
  console.log(JSON.stringify(run(), null, 2));
}
