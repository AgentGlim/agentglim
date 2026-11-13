// setup.mjs: first-run Setup (AgentGlim goes public). Each user turns on only the tools they have.
// Saved in $AGENTGLIM_DATA/setup.json (under the work dir when AGENTGLIM_WORK is set). With no file, everything
// defaults to what this machine has (binaries on PATH, login files, keys present), so an existing install looks the same.
//   detect()        what exists here (never key values: only whether a key is set and where from)
//   loadSetup()     saved config merged over the detected defaults; firstRun = no file yet
//   saveSetup(obj)  validates and writes setup.json (keeps a .bak of the previous one)
//   setupView(cfg)  the small slice the dashboard needs: enabled harnesses, limit ids, hidden providers, custom cards
import fs from 'node:fs';
import path from 'node:path';
import { HOME, DATA, PLANS } from './paths.mjs';
import { integrations } from './integrations.mjs';
import { key, keySource, keyEntries, keyStatuses } from './env.mjs';
import { execFile } from 'node:child_process';
import { harnessConfig, AGENTGLIM_ROOT } from './settings.mjs';
import { loadPrices, planPrice, atomicJson } from './price-data.mjs';
import { findBinary } from './deps.mjs';
import { sameAppRequest } from './open-url-rules.mjs';
import { cleanAliases, cleanPrefixes, cleanIcons } from './user-config.mjs';

export const SETUP_FILE = path.join(DATA, 'setup.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const has = (f) => { try { fs.accessSync(f); return true; } catch { return false; } };
const exp = (p) => String(p || '').replace(/^~(?=\/|$)/, HOME);
const tilde = (p) => String(p || '').replace(HOME, '~');
// Share PATH delimiters and Windows executable suffixes with dependency detection.
function onPath(bin) {
  const file = findBinary(bin);
  return file ? tilde(file) : null;
}

export const HARNESSES = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', auth: ['~/.claude/.credentials.json', '~/.claude.json'], authEnv: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], url: 'https://claude.com/claude-code' },
  { id: 'codex', name: 'Codex', bin: 'codex', auth: ['~/.codex/auth.json'], authEnv: ['OPENAI_API_KEY'], url: 'https://github.com/openai/codex' },
  { id: 'pi', name: 'Pi', bin: 'pi', auth: ['~/.pi/agent/auth.json'], authEnv: [], url: 'https://github.com/badlogic/pi-mono' },
  { id: 'opencode', name: 'OpenCode', bin: 'opencode', auth: ['~/.local/share/opencode/auth.json'], authEnv: ['OPENCODE_API_KEY'], url: 'https://opencode.ai' },
];
// free tiers; alt = other names this install already uses for the same key (detected too, never shown)
export const FREE_APIS = [
  { id: 'openrouter', name: 'OpenRouter (free models)', env: ['OPENROUTER_API_KEY'], alt: ['OPENROUTER_API_KEY_INFO'], signup: 'https://openrouter.ai/keys', note: 'Models ending in :free cost $0 (rate-limited).', used: true },
  { id: 'opencode', name: 'OpenCode Zen (free models)', env: ['OPENCODE_API_KEY'], alt: ['OPENCODE_API_KEY_DATA', 'OPENCODE_API_KEY_INFO'], signup: 'https://opencode.ai/auth', note: 'Zen lists a few free models; the same key works for paid Zen models.', used: true },
  { id: 'groq', name: 'Groq', env: ['GROQ_API_KEY'], alt: [], signup: 'https://console.groq.com/keys', note: 'Free tier with per-minute and per-day caps.', used: true },
  { id: 'cloudflare', name: 'Cloudflare Workers AI', env: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_WORKERS_AI_API_KEY'], alt: [], signup: 'https://dash.cloudflare.com/profile/api-tokens', note: '10k free neurons a day. Needs your account id and a Workers AI token.', used: true },
  { id: 'google-ai-studio', name: 'Google AI Studio (Gemini)', env: ['GOOGLE_AI_STUDIO_API_KEY'], alt: ['GEMINI_API_KEY'], signup: 'https://aistudio.google.com/apikey', note: 'Free tier for Gemini Flash models; prompts may be used for training.', used: true },
  { id: 'cerebras', name: 'Cerebras', env: ['CEREBRAS_API_KEY'], alt: [], signup: 'https://cloud.cerebras.ai', note: 'Free tier. Shown here for reference; no worker lane uses it yet.', used: false },
  { id: 'mistral', name: 'Mistral (La Plateforme free tier)', env: ['MISTRAL_API_KEY'], alt: [], signup: 'https://console.mistral.ai/api-keys', note: 'Experiment plan is free. Not used by worker lanes yet.', used: false },
  { id: 'github-models', name: 'GitHub Models', env: ['GITHUB_TOKEN'], alt: ['GITHUB_MODELS_TOKEN'], signup: 'https://github.com/settings/tokens', note: 'Free, low rate limits; a fine-grained token with models:read. Not used by worker lanes yet.', used: false },
];
export const SUBS = [
  { id: 'claude', name: 'Claude plan', harness: 'claude', provider: 'anthropic', env: 'CLAUDE_CODE_OAUTH_TOKEN', auth: '~/.claude/.credentials.json' },
  { id: 'codex', name: 'ChatGPT / Codex plan', harness: 'codex', provider: 'codex', env: 'CODEX_ACCESS_TOKEN', auth: '~/.codex/auth.json' },
  { id: 'go', name: 'OpenCode Go', harness: 'opencode', provider: 'opencode-go', env: 'OPENCODE_API_KEY', aliases: ['OPENCODE_API_KEY_DATA','OPENCODE_API_KEY_INFO'] },
];
export function normalizeEntries(id, sub = {}) {
  const spec = SUBS.find(x => x.id === id), tiers = loadPrices().providers[id].tiers;
  if (Array.isArray(sub.entries)) return sub.entries.slice(0,100).map((e,n) => {
    const tier = tiers.find(t => t.id === e.tier);
    const credential = String(e.credential || '').slice(0,400);
    return { id:n ? `${id}${n+1}` : id, tier:tier?.id || '', price:Number.isFinite(e.price) && e.price >= 0 ? e.price : tier?.usd ?? null,
      credential: /^[A-Z][A-Z0-9_]*$/.test(credential) || /^(~\/|\/|[A-Za-z]:[\\/])/.test(credential) && /\.json$/.test(credential) ? credential : '' };
  });
  let inferred = '';
  const recent = readJson(path.join(DATA,'usage-limits.json'))?.limits?.find(l=>l.id===id) || budgetLimits().find(l=>l.id===id);
  if(id==='codex') { const plan=String(recent?.plan || '').toLowerCase();inferred=({free:'free',go:'go',plus:'plus',prolite:'pro100',pro100:'pro100',pro200:'pro200',pro500:'pro500'})[plan] || ''; }
  if(id==='claude') { const a=readJson(exp(spec.auth))?.claudeAiOauth || {}; const plan=String(recent?.plan || a.rateLimitTier || a.subscriptionType || '');inferred=/20x/i.test(plan) ? 'max20' : /5x/i.test(plan) ? 'max5' : /(?:^|_)pro(?:$|_)/i.test(plan) ? 'pro' : ''; }
  sub={...sub,plan:sub.plan || inferred};
  const match = tiers.find(t => `${t.label} $${t.usd}` === sub.plan || t.id === sub.plan) || (sub.plan ? tiers.find(t => t.usd === +(String(sub.plan).match(/\$(\d+)/)?.[1] || -1)) : null);
  const count = id === 'go' ? Math.max(1,Math.min(100,+sub.keys || 1)) : 1;
  const legacyKeys = id === 'go' ? (spec.aliases || []).filter(n => keySource(n)).map(name=>({name})) : [];
  const detectedKeys = id === 'go' ? (legacyKeys.length ? legacyKeys : keyEntries(spec.env,spec.aliases)) : [];
  return Array.from({length:count},(_,n) => ({ id:n ? `${id}${n+1}` : id, tier:match?.id || (id === 'go' ? 'go' : ''), price:match?.usd ?? (id === 'go' ? planPrice(id,'go') : null), credential:detectedKeys[n]?.name || (n ? `${spec.env}_${n+1}` : spec.auth || spec.env) }));
}
export function setupCatalog() { const prices = loadPrices(); return { harnesses:HARNESSES, freeApis:FREE_APIS, subs:SUBS.map(s => ({...s, plans:prices.providers[s.id].tiers})), prices }; }
export function credentialSet(ref) { return /^[A-Z][A-Z0-9_]*$/.test(ref || '') ? !!keySource(ref) : !!ref && has(exp(ref)); }
export function providerStatuses() {
  return Object.fromEntries([...SUBS.map(s => [s.id,s.env,s.aliases || []]), ...FREE_APIS.map(s => [`api-${s.id}`,s.env[0],s.alt]), ['anthropic-api','ANTHROPIC_API_KEY',[]],['openai-api','OPENAI_API_KEY',[]],['jev','JEV_API_KEY',[]],['elevenlabs','ELEVENLABS_API_KEY',[]]].map(([id,env,aliases]) => [id,keyStatuses(env,aliases)]));
}

function budgetLimits() {
  const run = process.env.AGENTGLIM_RUN || `${PLANS}/_run`;
  return readJson(`${run}/budget.json`)?.limits || [];
}

export function detect() {
  const harnesses = HARNESSES.map((h) => {
    const bin = onPath(h.bin);
    const authFile = h.auth.map(exp).find(has);
    const authEnv = h.authEnv.find((n) => keySource(n));
    return { id: h.id, name: h.name, url: h.url, bin, auth: authFile ? tilde(authFile) : authEnv ? `${authEnv} (${keySource(authEnv)})` : null, found: !!(bin || authFile) };
  });
  const keys = FREE_APIS.map((a) => {
    const src = (n) => keySource(n) || keyEntries(n)[0]?.source;
    const parts = a.env.map((n) => ({ name: n, source: src(n) || [n, ...a.alt].map((x) => src(x) && `${src(x)} as ${x}`).find(Boolean) || null }));
    if (a.env.length === 1 && !parts[0].source) { const alt = a.alt.find(src); if (alt) parts[0].source = `${src(alt)} as ${alt}`; }
    return { id: a.id, found: parts.every((p) => p.source), parts };
  });
  const lim = budgetLimits();
  const goKeys = lim.filter((l) => l.provider === 'opencode-go').length || keyEntries('OPENCODE_API_KEY', ['OPENCODE_API_KEY_DATA','OPENCODE_API_KEY_INFO']).length;
  const local = {
    llamacpp: { bin: onPath('llama-server'), endpoint: 'http://127.0.0.1:8080' },
    ollama: { bin: onPath('ollama'), endpoint: 'http://127.0.0.1:11434' },
  };
  return {
    harnesses, keys, keyFamilies: providerStatuses(), goKeys, budgetIds: lim.map((l) => l.id),
    jev: jevStatus(),
    eleven: !!keySource('ELEVENLABS_API_KEY'),
    plans: { path: tilde(PLANS), found: has(PLANS) },
    notify: { bin: onPath('agent-notify') },
    local,
    custom: { leads: !!integrations.leadsPath && has(integrations.leadsPath), emailseq: !!integrations.emailSequencePath && has(integrations.emailSequencePath) },
  };
}

function defaults(d) {
  const on = Object.fromEntries(d.harnesses.map((h) => [h.id, h.found]));
  return {
    version: 1,
    jev: { on: true },
    harnesses: on,
    subs: { claude: { on: !!d.harnesses.find(h=>h.id==='claude')?.auth, plan: '' }, codex: { on: !!d.harnesses.find(h=>h.id==='codex')?.auth, plan: '' }, go: { on: d.goKeys > 0, keys: Math.max(1, d.goKeys || 1) } },
    local: { llamacpp: { on: !!d.local.llamacpp.bin, endpoint: d.local.llamacpp.endpoint }, ollama: { on: !!d.local.ollama.bin, endpoint: d.local.ollama.endpoint } },
    plans: { path: d.plans.found ? d.plans.path : '' },
    notify: { on: !!d.notify.bin, command: d.notify.bin ? 'agent-notify' : '' },
    custom: [],
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => { if (!isObj(b)) return b === undefined ? a : b; const o = { ...(isObj(a) ? a : {}) }; for (const [k, v] of Object.entries(b)) o[k] = merge(o[k], v); return o; };

export const legacyComplete = (saved) => !!isObj(saved) && saved.setupComplete === undefined && saved.version === 1
  && (Object.values(isObj(saved.harnesses) ? saved.harnesses : {}).some(Boolean) || !!saved.plans?.path);
// setupFilled(): THE single gate for the "Your AI agent" popup (agent-notice.mjs, portable-ui.js). Only an install
// whose setup file is not filled out gets the popup; a filled-out one never does (staleness is a banner there).
// Filled out = the v2 flag Setup saves, the private setup-complete marker, or a saved setup from before the flag
// existed: "version": 1 files were only ever written by the old Setup page's save, so one with harnesses or a plans
// path is a finished setup. A missing, empty or unreadable file, or one without a version (e.g. a partial one an
// agent wrote), still needs Setup.
export function setupFilled(saved = readJson(SETUP_FILE), data = DATA) {
  // An explicit incomplete save wins over a marker left by an earlier successful setup.
  if (isObj(saved) && saved.setupComplete === false) return false;
  return (!!isObj(saved) && saved.setupComplete === true) || has(path.join(data, 'setup-complete')) || legacyComplete(saved);
}
export function loadSetup(d = detect()) {
  const saved = readJson(SETUP_FILE);
  const cfg = merge(defaults(d), isObj(saved) ? saved : {});
  for (const id of ['claude','codex','go']) { cfg.subs[id].entries = normalizeEntries(id, cfg.subs[id]); cfg.subs[id].keys = cfg.subs[id].entries.length; }
  cfg.providerKeys ||= {};
  cfg.setupComplete = setupFilled(saved); // the one gate; see setupFilled()
  if (saved && Array.isArray(saved.custom)) cfg.custom = saved.custom; // a saved list replaces the default one
  return { ...cfg, firstRun: !saved, file: tilde(SETUP_FILE) };
}

const str = (v, n = 300) => String(v ?? '').slice(0, n);
const SHOW = ['counts', 'progress', 'lastRun'];
const KINDS = ['folder', 'file', 'leads', 'emailseq'];
export function clean(input) {
  const i = isObj(input) ? input : {};
  const b = (v) => !!v;
  const out = {
    version: 2, setupComplete: true,
    budget: {apiDailyUsd:Number.isFinite(+i.budget?.apiDailyUsd) ? Math.max(0,Math.min(10000,+i.budget.apiDailyUsd)) : 5},
    guard: { autoStopHours: Number.isFinite(+i.guard?.autoStopHours) ? Math.max(0,Math.min(168,+i.guard.autoStopHours)) : 0 },
    providerKeys: Object.fromEntries(Object.entries(i.providerKeys || {}).filter(([k]) => /^[a-z0-9-]+$/.test(k)).map(([k,v]) => [k, Array.isArray(v) ? v.slice(0,100).filter(n => /^[A-Z][A-Z0-9_]*$/.test(n)) : []])),
    jev: { on: i.jev?.on !== false },
    harnesses: Object.fromEntries(HARNESSES.map((h) => [h.id, b(i.harnesses?.[h.id])])),
    subs: Object.fromEntries(['claude','codex','go'].map(id => { const entries = normalizeEntries(id,i.subs?.[id]); return [id,{ on:b(i.subs?.[id]?.on), entries, keys:entries.length, plan:str(i.subs?.[id]?.plan,40) }]; })),
    local: Object.fromEntries(['llamacpp', 'ollama'].map((k) => [k, { on: b(i.local?.[k]?.on), endpoint: /^https?:\/\/[\w.\-:[\]]+(\/\S*)?$/.test(i.local?.[k]?.endpoint || '') ? str(i.local[k].endpoint, 200) : '' }])),
    plans: { path: str(i.plans?.path, 400) },
    notify: { on: b(i.notify?.on), command: str(i.notify?.command, 200) },
    // the owner's own client names, kept across Setup saves (owner-attention reads them; empty by default)
    clientKeywords: (Array.isArray(i.clientKeywords) ? i.clientKeywords : []).filter((k) => typeof k === 'string' && k.trim()).slice(0, 40).map((k) => k.trim().slice(0, 40)),
    // the owner's own skill-id prefixes, project icon overrides and host aliases (user-config.mjs reads them;
    // validated there, so a Setup save keeps them and a malformed value is dropped)
    skillPrefixes: cleanPrefixes(i.skillPrefixes),
    projectIcons: (() => { const { paths, kinds } = cleanIcons(i.projectIcons); return Object.fromEntries(Object.keys(paths).map((n) => [n, { ...(paths[n] ? { path: paths[n] } : {}), ...(kinds[n] ? { kind: kinds[n] } : {}) }])); })(),
    hostAliases: cleanAliases(i.hostAliases),
    custom: (Array.isArray(i.custom) ? i.custom : []).slice(0, 30).map((c, n) => ({
      id: str(c?.id || `p${n + 1}`, 40).replace(/[^\w-]/g, '') || `p${n + 1}`,
      name: str(c?.name, 80) || `Project ${n + 1}`,
      kind: KINDS.includes(c?.kind) ? c.kind : 'folder',
      path: str(c?.path, 400),
      show: (Array.isArray(c?.show) ? c.show : SHOW).filter((x) => SHOW.includes(x)),
    })).filter((c) => c.path || c.kind === 'leads' || c.kind === 'emailseq'),
  };
  const ids = new Set(); for (const c of out.custom) { while (ids.has(c.id)) c.id += '_'; ids.add(c.id); }
  return out;
}

// complete:false saves the choices but leaves setup "not filled out" (no marker, setupComplete:false) until
// completeSetup() runs; first-run.mjs uses it so a failed tool install is retried instead of recorded as done.
export function saveSetup(input, { complete = true } = {}) {
  const out = clean(input);
  if (!complete) out.setupComplete = false;
  fs.mkdirSync(path.dirname(SETUP_FILE), { recursive: true });
  if (has(SETUP_FILE)) fs.copyFileSync(SETUP_FILE, `${SETUP_FILE}.bak`);
  atomicJson(SETUP_FILE, out);
  if (complete) fs.writeFileSync(path.join(DATA,'setup-complete'), new Date().toISOString());
  const budgetFile = path.join(DATA,'budget.json');
  atomicJson(budgetFile, { version:1, ...(readJson(budgetFile) || {}), apiDailyUsd:out.budget.apiDailyUsd, monthlySubscriptions: Object.values(out.subs).reduce((n,s) => n+(s.on ? s.entries.reduce((n,e) => n+(e.price || 0),0) : 0),0), pollMs:readJson(budgetFile)?.pollMs || {claude:900000,codex:120000,go:120000}, acceptedAt:new Date().toISOString() });
  return out;
}

export function completeSetup() {
  const saved = readJson(SETUP_FILE);
  if (isObj(saved) && saved.setupComplete !== true) atomicJson(SETUP_FILE, { ...saved, setupComplete: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'setup-complete'), new Date().toISOString());
}

// generic custom project: read-only counts / progress / last run from a folder or a data file
function stats(c) {
  const f = exp(c.path); let st;
  try { st = fs.statSync(f); } catch { return { error: 'not found' }; }
  if (st.isDirectory()) {
    let n = 0, dirs = 0, last = st.mtimeMs;
    try { for (const e of fs.readdirSync(f, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; e.isDirectory() ? dirs++ : n++; try { last = Math.max(last, fs.statSync(path.join(f, e.name)).mtimeMs); } catch {} } } catch {}
    return { counts: { files: n, folders: dirs }, lastRun: last };
  }
  const out = { lastRun: st.mtimeMs };
  if (st.size > 20e6) return { ...out, error: 'file over 20 MB' };
  const text = fs.readFileSync(f, 'utf8');
  if (/\.json$/i.test(f)) {
    let j; try { j = JSON.parse(text); } catch { return { ...out, error: 'not valid JSON' }; }
    const arr = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : null;
    if (arr) { out.counts = { items: arr.length }; const done = arr.filter((x) => x && (x.done === true || /^(done|complete|completed)$/i.test(x.status || x.state || ''))).length; if (arr.length) out.progress = { done, total: arr.length }; }
    if (isObj(j)) {
      const num = Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === 'number').slice(0, 6));
      if (Object.keys(num).length) out.counts = { ...(out.counts || {}), ...num };
      if (typeof j.done === 'number' && typeof j.total === 'number') out.progress = { done: j.done, total: j.total };
      const lr = j.lastRun || j.last_run || j.updated || j.at; const t = typeof lr === 'number' ? lr : Date.parse(lr || '');
      if (t) out.lastRun = t;
    }
  } else {
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
    out.counts = { rows: /\.csv$/i.test(f) ? Math.max(0, lines - 1) : lines };
  }
  return out;
}

export function setupView(cfg = loadSetup()) {
  const sub = cfg.subs || {};
  const limitIds = [];
  for (const id of ['claude','codex','go']) if (sub[id]?.on) limitIds.push(...normalizeEntries(id,sub[id]).map(e => e.id));
  const hidden = SUBS.filter((s) => !sub[s.id]?.on && !cfg.harnesses?.[s.harness]).map((s) => s.provider);
  return {
    firstRun: cfg.firstRun, setupComplete:cfg.setupComplete, setupFilled:cfg.setupComplete, harnesses: cfg.harnesses, limitIds, hiddenProviders: hidden,
    subs: { claude: !!sub.claude?.on, codex: !!sub.codex?.on, go: sub.go?.on ? sub.go.keys || 1 : 0 },
    custom: (cfg.custom || []).map((c) => ({ id: c.id, name: c.name, kind: c.kind, show: c.show, ...(c.kind === 'folder' || c.kind === 'file' ? { path: c.path, stats: stats(c) } : {}) })),
  };
}

// Resolve through the same settings and key loader as the CLI; never return credentials.
export function jevStatus() {
  const cfg = harnessConfig();
  const entries=keyEntries('JEV_API_KEY');
  const source = entries[0]?.source || null;
  return { keySet: !!source, keyCount:entries.length, source, routes: tilde(cfg.jev.routes), routingUrl: '/routing' };
}

export function testJevRouting(run = execFile) {
  const apiKey = keyEntries('JEV_API_KEY')[0]?.value;
  if (!apiKey) return Promise.resolve({ error: 'No JEV_API_KEY set. Add it to your .env and restart AgentGlim.' });
  return new Promise((resolve) => {
    run(process.execPath, [path.join(AGENTGLIM_ROOT, 'harness/bin/jev-route.mjs'), 'rename a variable'],
      { cwd: AGENTGLIM_ROOT, timeout: 60000, maxBuffer: 256 * 1024, env: { ...process.env, JEV_API_KEY: apiKey } },
      (err, stdout) => {
        // Do not expose subprocess stderr or API error bodies: either could contain credentials.
        if (err?.killed) return resolve({ error: 'Routing test timed out after 60 seconds.' });
        let result;
        for (const line of String(stdout || '').trim().split('\n').reverse()) {
          try { result = JSON.parse(line); break; } catch {}
        }
        if (err || result?.error) return resolve({ error: 'Jev routing failed. Check your key, network connection and routes file.' });
        if (typeof result?.pick !== 'string' || !Number.isFinite(result.p) || typeof result.effort !== 'string')
          return resolve({ error: 'Jev returned no usable routing result.' });
        const safe = (s) => keyEntries('JEV_API_KEY').reduce((s,e)=>s.split(e.value).join('[redacted]'),s);
        resolve({ pick: safe(result.pick), p: result.p, effort: safe(result.effort) });
      });
  });
}

export async function jevSetupEndpoint(req, res, route) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  const send = (code, body) => { res.writeHead(code, headers); res.end(JSON.stringify(body)); };
  if (req.method !== 'GET') return send(405, { error: 'GET only' });
  // Same-origin GET fetches carry Referer rather than Origin in browsers.
  let origin = req.headers.origin;
  if (!origin) { try { origin = new URL(req.headers.referer).origin; } catch {} }
  if (!sameAppRequest({ ...req.headers, origin }) || origin !== `http://${req.headers.host}` || req.headers['sec-fetch-site'] === 'cross-site')
    return send(403, { error: 'same-origin only' });
  if (route === '/api/setup/jev') return send(200, { ...jevStatus(), on: loadSetup().jev.on });
  const result = await testJevRouting();
  send(result.error ? 400 : 200, result);
}

export function providerKeyEntries(id, base, aliases=[]) {
  const all=keyEntries(base,aliases),selected=loadSetup().providerKeys?.[id];
  return Array.isArray(selected) ? all.filter(e=>selected.includes(e.name)) : all;
}
