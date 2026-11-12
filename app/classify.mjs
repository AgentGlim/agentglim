// Model classifier for the observatory: maps an agent kind + model id to a provider (icon, color) and billing class.
// Order: approved entries (data/classes.json) > name rules > Jev (TypeSafe) for names the rules can't place.
// Prices come from the configured model-price ledger when it lists the model; otherwise the entry is flagged.
//   node classify.mjs          report every agent.sh kind and every (kind, model) the run has used, with its review state
//   node classify.mjs --jev    same, asking Jev about the ones the rules can't place (answers cached in data/jev-cache.json)
//   node classify.mjs --ask KIND MODEL   one fresh Jev call for that pair, printed next to the rule and approved answers
// The server imports this module, classifies live on every scan and re-checks when agent.sh or worker.sh changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { providerKeyEntries } from './setup.mjs';
import { key, nextKey } from './env.mjs'; // API keys: process env, then <repo>/.env, then ~/.bashrc (deprecated)
import { DATA, RUN } from './paths.mjs';
import { modelPricesFile } from './integrations.mjs';
const APPROVED = `${DATA}/classes.json`;
const JEV_CACHE = `${DATA}/jev-cache.json`;
export const JEV_USAGE = `${DATA}/jev-usage.ndjson`; // one line per Jev call: the server charts it as provider "jev"
const PRICES = modelPricesFile;
export const AGENT_SH = `${RUN}/bin/agent.sh`;
export const WORKER_SH = `${RUN}/bin/worker.sh`;
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';

export const PROVIDERS = ['anthropic', 'claude-cloud', 'codex', 'deepseek', 'opencode-go', 'opencode', 'openrouter', 'antigravity', 'elevenlabs', 'groq', 'google-ai-studio', 'cloudflare', 'qwen', 'llama.cpp', 'ollama'];
export const CLASSES = ['subscription', 'free', 'paid-api', 'local', 'other'];
// what Jev reads for each candidate
const PROV_DESC = {
  anthropic: 'Anthropic Claude (Opus, Sonnet, Haiku) on the Claude subscription',
  codex: 'OpenAI GPT / Codex models on the ChatGPT Codex subscription',
  deepseek: 'DeepSeek models bought directly from the DeepSeek API',
  'opencode-go': 'a model on the OpenCode Go subscription plan',
  opencode: 'a free model on OpenCode Zen',
  antigravity: 'a free model (Gemini, Claude 4.6, GPT-OSS) through the Antigravity CLI on a Google login',
  openrouter: 'a model routed through OpenRouter',
  groq: 'a free-tier model on the Groq API (GroqCloud)',
  'google-ai-studio': 'a free-tier Gemini model on the Google AI Studio (Gemini API) key',
  cloudflare: 'a free-tier model on Cloudflare Workers AI',
  'claude-cloud': 'a Claude Code cloud session (claude.ai/code), paid from the cloud usage credit, not the subscription',
  qwen: 'Qwen Flash Next on the local Strata server on this PC',
  'llama.cpp': 'a local model on a llama.cpp server',
  ollama: 'a local model on Ollama',
};
const CLASS_DESC = {
  subscription: 'covered by a flat monthly subscription', free: 'free of charge', 'paid-api': 'billed per token on a paid API',
  local: 'running locally on own hardware', other: 'none of these',
};

// parsed once per file change: the server classifies every job on every 5 s scan
const jsonCache = new Map();
const readJson = (f, d) => {
  let st; try { st = fs.statSync(f); } catch { return d; }
  const c = jsonCache.get(f);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.v;
  try { const v = JSON.parse(fs.readFileSync(f, 'utf8')); jsonCache.set(f, { mtime: st.mtimeMs, size: st.size, v }); return v; } catch { return d; }
};
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
// "pi(none)" and friends are the same kind as "pi"
export const kindOf = (k) => String(k || '?').replace(/\(.*\)$/, '');
export const keyOf = (kind, model) => `${kindOf(kind)}|${model || '?'}`;

// kinds agent.sh knows: its usage line "agent.sh <premium|codex|...|zen:MODEL> ..."
export function agentKinds() {
  const m = (fs.existsSync(AGENT_SH) ? fs.readFileSync(AGENT_SH, 'utf8') : '').match(/agent\.sh <([^>]+)>/);
  return m ? m[1].split('|').map((k) => k.replace(/:.*/, ':')) : [];
}

// name rules: model id first, then the kind; null when nothing matches
export function ruleClass(kind, model) {
  const k = kindOf(kind), m = String(model || '').toLowerCase();
  const free = /(^|[-:/])free\b/.test(m) || /^stealth\//.test(m); // OpenRouter stealth/ models are $0 (Crouton, 2026-11-05)
  if (k.startsWith('agy:')) return { provider: 'antigravity', class: 'free', rule: 'agy: kind' }; // before the Claude name rule: agy's Claude 4.6 is free
  if (k.startsWith('zen:')) return { provider: 'opencode', class: 'free', rule: 'zen: kind' };
  // free-tier API workers (worker.sh groq-1 / gai-1 / cfai-1, 2026-11-06): before the gofree: catch-all and the local /qwen/ rule
  if (k.startsWith('gofree:groq/')) return { provider: 'groq', class: 'free', rule: 'gofree:groq/ kind (Groq free tier)' };
  // gai-1: Gemini on the Google AI Studio key, free tier (its own provider, like cfai)
  if (k.startsWith('gofree:google/')) return { provider: 'google-ai-studio', class: 'free', rule: 'gofree:google/ kind (Google AI Studio free tier)' };
  if (k.startsWith('gofree:cfai/')) return { provider: 'cloudflare', class: 'free', rule: 'gofree:cfai/ kind (Cloudflare Workers AI free tier)' };
  // pi:opencode-go/<model> (and go2): OpenCode Go subscription; probes log no model= line (2026-11-06 reject)
  if (/^pi:opencode-go2?\//.test(k)) return { provider: 'opencode-go', class: 'subscription', rule: 'pi:opencode-go/ kind (Go plan)' };
  if (k.startsWith('gofree:')) return { provider: 'opencode-go', class: 'free', rule: 'gofree: kind' };
  if (k === 'cloud') return { provider: 'claude-cloud', class: 'other', rule: 'cloud: Claude Code cloud session (cloud credit)' }; // cloud-round.sh (2026-11-04)
  if (/^openrouter\//.test(m) || k === 'pi-or') return { provider: 'openrouter', class: free ? 'free' : 'paid-api', rule: 'openrouter model' };
  if (/claude|opus|sonnet|haiku/.test(m) || /^(haiku|sonnet|opus)$/.test(k)) return { provider: 'anthropic', class: 'subscription', rule: 'Claude model name' };
  if (/^(gpt-|o\d\b)|codex/.test(m) || /^(codex|luna)/.test(k)) return { provider: 'codex', class: 'subscription', rule: 'GPT/Codex model name' };
  if (/^ai-local-workers\/qwen3\.6|^qwen3\.6/.test(m)) return { provider: 'qwen', class: 'local', rule: 'Owner Qwen3.6 116K four-worker pilot' };
  if (/^strata\/|flash-next/.test(m) || (k === 'pi-local' && !m)) return { provider: 'qwen', class: 'local', rule: 'Local Qwen model' };
  if (k === 'pi-local' || /qwen|gemma|llama|phi-?\d/.test(m)) return { provider: 'llama.cpp', class: 'local', rule: 'local model name' };
  if (/deepseek/.test(m)) return { provider: 'deepseek', class: 'paid-api', rule: 'DeepSeek model name' };
  if (free) return { provider: 'opencode-go', class: 'free', rule: '-free model name' };
  return null;
}

// price per 1M tokens from model_prices.json: exact id, with or without a provider/ prefix, ":free" = "-free"
export function priceOf(model) {
  if (!model) return null;
  const table = readJson(PRICES, {}).models || {};
  const bare = (s) => s.toLowerCase().replace(/^[^/]+\//, '').replace(/:free$/, '-free');
  const want = bare(model);
  const key = Object.keys(table).find((k) => k.toLowerCase() === model.toLowerCase()) || Object.keys(table).find((k) => bare(k) === want);
  if (!key) return null;
  const c = table[key].current || {};
  return { key, input: c.input, cached: c.cached_input, write: c.cache_write, output: c.output, confirmed: table[key].confirmed_at };
}

export const loadApproved = () => readJson(APPROVED, {});
export function approve(key, entry) {
  const all = loadApproved();
  all[key] = { ...entry, approvedAt: new Date().toISOString() };
  writeJson(APPROVED, all);
  return all[key];
}

// ---------- Jev: noul (yes/no probability) questions, one per candidate provider and class ----------
let jevKeyIndex=0;
const jevKey = () => {const entries=providerKeyEntries('jev','JEV_API_KEY');return entries.length ? entries[jevKeyIndex++ % entries.length].value : null;};
const jevCache = () => readJson(JEV_CACHE, {});
// generic Jev call (Jev is the first pass for model and plan-priority labels; Opus reviews when it is unsure)
export async function jevAsk(state, questions, tag = 'jev') {
  const apiKey = jevKey();
  if (!apiKey) return { error: 'no JEV_API_KEY' };
  try {
    const r = await fetch(JEV_URL, { method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state, model: JEV_MODEL, questions }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { error: `HTTP ${r.status}`, detail: JSON.stringify(body).slice(0, 200) };
    // read-only sandboxes (plans workers): skip the usage line, keep the paid answer
    try { fs.appendFileSync(JEV_USAGE, JSON.stringify({ t: Date.now(), model: body.model || JEV_MODEL, input: body.usage?.input_tokens || 0,
      output: body.usage?.output_tokens || 0, key: tag, requestId: r.headers.get('x-typesafe-request-id') }) + '\n'); } catch {}
    return { answers: body.answers || {}, model: body.model };
  } catch (e) { return { error: String(e.message || e) }; }
}
export const jevBest = (answers, prefix) => best(answers, prefix);
export const jevAnswer = (key) => jevCache()[key] || null;
const best = (answers, prefix) => Object.entries(answers || {}).filter(([q]) => q.startsWith(prefix))
  .map(([q, a]) => [q.slice(prefix.length), Number(a?.noul)]).filter(([, p]) => Number.isFinite(p)).sort((a, b) => b[1] - a[1])[0];

export async function askJev(kind, model, notes = []) {
  const key = keyOf(kind, model);
  const cache = jevCache();
  if (cache[key] && !cache[key].error) return cache[key];
  const apiKey = jevKey();
  if (!apiKey) return null;
  const questions = {};
  for (const p of PROVIDERS) questions[`p_${p}`] = { type: 'noul', instructions: `Is this AI agent most likely ${PROV_DESC[p]}?` };
  for (const c of CLASSES) questions[`c_${c}`] = { type: 'noul', instructions: `Is this agent's usage most likely ${CLASS_DESC[c]}?` };
  const state = `A build-pipeline agent was launched with agent kind "${kindOf(kind)}" and model id "${model || 'unknown'}".`
    + (notes.length ? ` Its launcher log says: ${notes.slice(-4).join(' | ')}` : '');
  let out;
  try {
    const r = await fetch(JEV_URL, { method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ state, model: JEV_MODEL, questions }) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) out = { error: `HTTP ${r.status}`, detail: JSON.stringify(body).slice(0, 200), at: new Date().toISOString() };
    else {
      const p = best(body.answers, 'p_'), c = best(body.answers, 'c_');
      fs.appendFileSync(JEV_USAGE, JSON.stringify({ t: Date.now(), model: body.model || JEV_MODEL, input: body.usage?.input_tokens || 0,
        output: body.usage?.output_tokens || 0, key, requestId: r.headers.get('x-typesafe-request-id') }) + '\n');
      out = { provider: p?.[0] || null, providerP: p?.[1] ?? null, class: c?.[0] || null, classP: c?.[1] ?? null,
        jevModel: body.model, usage: body.usage, requestId: r.headers.get('x-typesafe-request-id'), at: new Date().toISOString() };
    }
  } catch (e) { out = { error: String(e.message || e), at: new Date().toISOString() }; }
  cache[key] = out; writeJson(JEV_CACHE, cache);
  return out;
}

// one classification: approved > rule > Jev > unknown
export function classify(kind, model) {
  const key = keyOf(kind, model);
  const a = loadApproved()[key];
  const rule = ruleClass(kind, model);
  const jev = jevAnswer(key);
  const price = priceOf(model);
  if (a) return { key, provider: a.provider, class: a.class, source: 'approved', approved: true, rule, jev, price };
  if (rule) return { key, provider: rule.provider, class: rule.class, source: 'rule', approved: false, rule, jev, price };
  if (jev?.provider) return { key, provider: jev.provider, class: jev.class || 'other', source: 'jev', approved: false, rule, jev, price };
  return { key, provider: '', class: 'other', source: 'unknown', approved: false, rule, jev, price };
}

// ---------- CLI report ----------
if (path.resolve(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const ai = process.argv.indexOf('--ask');
  if (ai > 0) {
    const [kind, model] = process.argv.slice(ai + 1);
    const cache = readJson(JEV_CACHE, {}); delete cache[keyOf(kind, model)]; writeJson(JEV_CACHE, cache);
    console.log(JSON.stringify({ approved: loadApproved()[keyOf(kind, model)] || null, rule: ruleClass(kind, model), jev: await askJev(kind, model) }, null, 2));
    process.exit(0);
  }
  const useJev = process.argv.includes('--jev');
  const res = await fetch('http://127.0.0.1:18990/api/snapshot').then((r) => r.json()).catch(() => null);
  const pairs = new Map();
  for (const k of agentKinds()) pairs.set(keyOf(k, null), { kind: k, model: null });
  for (const a of res?.agents || []) pairs.set(keyOf(a.kind, a.model), { kind: a.kind, model: a.model });
  if (!res) console.log('observatory not reachable; listing agent.sh kinds only');
  // like the server: an agent.sh kind needs no review once it has run or any of its models is approved
  const seen = new Set([...Object.values(loadApproved()).map((a) => a.kind), ...(res?.agents || []).map((a) => kindOf(a.kind))]);
  for (const [key, { kind, model }] of pairs) if (!model && seen.has(kindOf(kind)) && !loadApproved()[key]) pairs.delete(key);
  for (const { kind, model } of pairs.values()) {
    if (useJev && !ruleClass(kind, model) && !loadApproved()[keyOf(kind, model)]) await askJev(kind, model);
    const c = classify(kind, model);
    const p = c.price ? `$${c.price.input}/$${c.price.output} (${c.price.key})` : 'no price';
    console.log(`${c.approved ? 'ok     ' : 'REVIEW '} ${c.key.padEnd(48)} ${(c.provider || '?').padEnd(12)} ${c.class.padEnd(13)} ${c.source.padEnd(8)} ${p}`
      + (c.jev ? `  jev: ${c.jev.error || `${c.jev.provider} ${c.jev.providerP?.toFixed(2)}`}` : ''));
  }
}
