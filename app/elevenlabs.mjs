// elevenlabs.mjs: ElevenLabs (voice, sound effects, music) for AgentGlim. No dependencies.
// - ELEVEN_USAGE: the usage ledger, one JSON line per call made by AgentGlim tooling (tools/eleven.mjs).
//   server.mjs charts it as provider "elevenlabs" (class paid-api), priced by the plan rate in elevenlabs-rates.json.
// - subscription(): the card's credits used/left from GET /v1/user/subscription, cached, at most one call per pollMinutes.
// The key comes from env.mjs (ELEVENLABS_API_KEY in <repo>/.env). It is never printed, logged or sent anywhere but api.elevenlabs.io.
// Owner rule: API keys are for owner sessions only; plan runs never use this key.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { key, keySource, keyEntries } from './env.mjs';
import { providerKeyEntries } from './setup.mjs';
import { DATA } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RATES_FILE = path.join(HERE, 'elevenlabs-rates.json');
export const ELEVEN_USAGE = `${DATA}/elevenlabs-usage.ndjson`;
export const KEY_NAME = 'ELEVENLABS_API_KEY';
const API = 'https://api.elevenlabs.io';

export function rates() {
  const d = { plan: 'creator', planUsdPerMonth: 22, creditsPerMonth: 100000, usdPerCredit: 0.00022, creditsPerChar: { default: 1, flash: 0.5, turbo: 0.5 }, creditsPerSecondSfx: 20, creditsPerSecondMusic: 15, pollMinutes: 10 };
  try { return { ...d, ...JSON.parse(fs.readFileSync(RATES_FILE, 'utf8')) }; } catch { return d; }
}
export const usdOf = (credits, r = rates()) => (+credits || 0) * r.usdPerCredit;

// credit estimate before a call (the budget check) and when the response has no character-cost header
export function estimateCredits(kind, { text = '', model = '', seconds = 0 } = {}, r = rates()) {
  if (kind === 'tts') { const c = r.creditsPerChar || {}; const k = /flash/i.test(model) ? 'flash' : /turbo/i.test(model) ? 'turbo' : 'default'; return Math.ceil(String(text).length * (c[k] ?? c.default ?? 1)); }
  if (kind === 'sfx') return Math.ceil((seconds || 5) * r.creditsPerSecondSfx);
  if (kind === 'music') return Math.ceil((seconds || 30) * r.creditsPerSecondMusic);
  return 0;
}

// one ledger row: { t, kind, model, chars, credits, usd, est, file, run }
export function logUsage(row) {
  fs.mkdirSync(path.dirname(ELEVEN_USAGE), { recursive: true });
  fs.appendFileSync(ELEVEN_USAGE, JSON.stringify({ t: Date.now(), ...row }) + '\n');
}
export function ledger() {
  let t = ''; try { t = fs.readFileSync(ELEVEN_USAGE, 'utf8'); } catch {}
  return t.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// card data: { key, keySource, status: 'nokey' | 'ok' | 'noperm' | 'error' | 'pending', ... }; never the key itself
let cache = null, inflight = null;
export function subscription() {
  const r = rates(), entries=providerKeyEntries('elevenlabs',KEY_NAME), k=entries[0]?.value;
  const base = { key: !!k, keyCount:entries.length, keySource: entries[0]?.source || null, rate: { usdPerCredit: r.usdPerCredit, plan: r.plan, planUsdPerMonth: r.planUsdPerMonth, creditsPerMonth: r.creditsPerMonth }, pollMinutes: r.pollMinutes };
  if (!k) return { ...base, status: 'nokey' };
  const fresh = cache && Date.now() - cache.checkedAt < r.pollMinutes * 60e3;
  if (process.env.AGENTGLIM_DEV !== '1' && !fresh && !inflight) inflight = Promise.all(entries.map(async e => ({name:e.name,...await fetchSub(e.value)}))).then(accounts => { const good=accounts.filter(x=>x.status==='ok');cache={status:good.length ? 'ok' : accounts[0]?.status || 'nokey',checkedAt:Date.now(),accounts,used:good.reduce((n,a)=>n+a.used,0),limit:good.reduce((n,a)=>n+a.limit,0),left:good.reduce((n,a)=>n+a.left,0),tier:good.map(a=>a.tier).filter(Boolean).join(', '),resetAt:good.map(a=>a.resetAt).filter(Boolean).sort()[0] || null}; }).finally(() => { inflight = null; });
  return { ...base, ...(cache || { status: 'pending' }) };
}
async function fetchSub(k) {
  const checkedAt = Date.now();
  try {
    const res = await fetch(`${API}/v1/user/subscription`, { headers: { 'xi-api-key': k }, signal: AbortSignal.timeout(15e3) });
    if (res.status === 401 || res.status === 403) return { status: 'noperm', checkedAt };
    if (!res.ok) return { status: 'error', error: `HTTP ${res.status}`, checkedAt };
    const j = await res.json();
    const used = +j.character_count || 0, limit = +j.character_limit || 0;
    return { status: 'ok', checkedAt, tier: j.tier || null, used, limit, left: Math.max(0, limit - used),
      resetAt: j.next_character_count_reset_unix ? j.next_character_count_reset_unix * 1000 : null, state: j.status || null };
  } catch (e) { return { status: 'error', error: String(e?.name === 'TimeoutError' ? 'timeout' : e?.message || e).slice(0, 80), checkedAt }; }
}
