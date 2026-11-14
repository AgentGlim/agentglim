// Frozen copy of the plans-harness role resolver (2026-11-13), used only by roles.test.mjs so the test runs
// on any machine without a plans harness. Refresh it when the harness resolver API changes.
// Per-plan model mix: <plan>/ROUND_MODELS (owner 2026-11-10; keys focus/verify/audit/workers and codex-<model>
// values added 2026-11-11 for the overnight Codex and Claude loops). A plan without the file keeps today's routing.
//
//   {"rounds":"codex-terra","workers":"codex-terra","audit":"codex-terra","focus":"codex-sol","verify":"codex-astra"}
//   {"premium":"opus","rounds":"sonnet"}                       (the 2026-11-10 form, still valid)
//   {"rounds":"codex-terra|sonnet","verify":"codex-astra|opus"} ("a|b": either; the budget router picks per step)
//
// gpt-6.1-terra is refused for focus, verify, audit and premium: it is dropped from "a|b", and a
// terra-only value becomes codex-sol. rounds and workers keep it.
// Keys: rounds (round orchestrator, driver.mjs), workers (worker.sh paid lane; a pinned lane skips the free models),
// audit (round audits in audit.sh; the final-round audit when it runs), focus and verify (agent.sh premium).
// focus, verify and audit fall back to "premium". Values: opus | sonnet | fable | haiku | luna | pi |
// codex-sol | codex-terra | codex-astra | codex-luna | a literal gpt-* id. Codex rounds and workers run in Pi on the
// Codex login (agent.sh kind luna with that model): the Codex CLI cannot start the nested worker sandboxes.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CODEX = { sol: 'gpt-6.1-sol', terra: 'gpt-6.1-terra', astra: 'gpt-6-astra', luna: 'gpt-6-luna' };
// opus48: a fixed Claude Opus 4.8 pin (claude --model claude-opus-4-8); 'opus' = the newest Opus.
export const CLAUDE_IDS = { opus48: 'claude-opus-4-8' };
const CLAUDE = new Set(['opus', 'opus48', 'sonnet', 'fable', 'haiku']);
// "strict": true in ROUND_MODELS: the plan's pins are final. No global-policy swap, no 2 h pin
// fallback, no Codex/Jev/free swaps, no free worker pool; a gated pin waits.
export const isStrict = (rm) => rm?.strict === true;
const FALLBACK = { focus: 'premium', verify: 'premium', audit: 'premium' };
// gpt-6.1-terra never runs a premium step (focus, verify, audit, premium). It stays allowed for
// rounds and workers. In a premium key it is dropped from the value ("a|b" keeps the other side); with nothing
// left the default applies: Codex gpt-6.1-sol.
export const PREMIUM_KEYS = new Set(['focus', 'verify', 'audit', 'premium']);

// Canonical grid order also determines the fallback when a plan has no permitted choice.
export const ROLES = [
  { id: 'rounds', label: 'Orchestrator' }, { id: 'workers', label: 'Workers' },
  { id: 'audit', label: 'Audit' }, { id: 'focus', label: 'Focus' }, { id: 'verify', label: 'Verify' },
];
export const MODELS = [
  ...['sol', 'terra', 'luna', 'astra'].map((id) => ({ id: `codex-${id}`, label: id[0].toUpperCase() + id.slice(1), provider: 'Codex' })),
  ...['sonnet', 'opus', 'haiku', 'fable'].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1), provider: 'Claude' })),
  { id: 'opus48', label: 'Opus 4.8', provider: 'Claude' },
  { id: 'pi', label: 'Pi / DeepSeek', provider: 'Pi' },
  { id: 'gofree', label: 'Free API', provider: 'Free' }, { id: 'zen', label: 'Zen', provider: 'Free' },
  { id: 'pi-or', label: 'OpenRouter', provider: 'Free' }, { id: 'pi-local', label: 'Local', provider: 'Pi' },
  { id: 'agy', label: 'Antigravity', provider: 'Free' },
];
const WORKER_ONLY = new Set(['pi', 'gofree', 'zen', 'pi-or', 'pi-local', 'agy']);
export const supported = (role, model) => role === 'workers' || (!WORKER_ONLY.has(model) && !(model === 'codex-terra' && PREMIUM_KEYS.has(role)));
export const defaultPolicy = () => ({ version: 1, roles: Object.fromEntries(ROLES.map(({ id }) => [id,
  MODELS.filter((m) => id === 'rounds' ? ['codex-sol', 'codex-terra', 'codex-luna', 'sonnet', 'opus', 'opus48'].includes(m.id) : supported(id, m.id)).map((m) => m.id)])) });
export const policyFile = () => process.env.PLANS_ROLE_MODELS_FILE || fileURLToPath(new URL('../role-models.json', import.meta.url));
export function validatePolicy(value) {
  if (!value || value.version !== 1 || !value.roles || typeof value.roles !== 'object' || Array.isArray(value.roles)) throw new Error('version 1 and roles are required');
  if (Object.keys(value.roles).some((r) => !ROLES.some((x) => x.id === r))) throw new Error('Unknown role');
  const roles = {};
  for (const { id, label } of ROLES) {
    const row = value.roles[id];
    if (!Array.isArray(row) || !row.length) throw new Error(`${label} needs at least one allowed model`);
    if (row.some((m) => !MODELS.some((x) => x.id === m) || !supported(id, m))) throw new Error(`Unsupported model for ${label}`);
    // Ignore submitted ordering and duplicates: the displayed grid order is authoritative.
    roles[id] = MODELS.filter((m) => row.includes(m.id)).map((m) => m.id);
  }
  return { version: 1, roles };
}
export function readPolicy(file = policyFile()) {
  try { return validatePolicy(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`Cannot read role policy: ${e.message}`); }
}
export function writePolicy(value, file = policyFile()) {
  const policy = validatePolicy(value);
  fs.writeFileSync(`${file}.next`, JSON.stringify(policy, null, 2) + '\n');
  fs.renameSync(`${file}.next`, file);
  return policy;
}
export const modelKey = (value) => {
  const v = value.trim().toLowerCase().replace(/^claude-/, '');
  if (v === 'luna') return 'codex-luna';
  const c = codexId(v);
  if (c) { const match = Object.entries(CODEX).find(([, id]) => id === c); return match ? `codex-${match[0]}` : v; }
  return v.split(':')[0];
};
// Kept separate from spec's historical shell interface, so the UI can show every alternative.
export function choices(rm, key, { strict = false, policy = readPolicy() } = {}) {
  const v = rm?.[key] ?? (FALLBACK[key] && !strict ? rm?.[FALLBACK[key]] : undefined);
  const parts = typeof v === 'string' ? v.split('|').map((x) => x.trim().toLowerCase().replace(/^claude-/, '')).filter(Boolean) : [];
  if (!policy || (isStrict(rm) && parts.length)) return parts; // strict pin: the plan's choice wins over the grid
  // Generic premium launches must satisfy all three premium-role rows.
  const allowed = key === 'premium' ? policy.roles.focus.filter((m) => policy.roles.verify.includes(m) && policy.roles.audit.includes(m)) : policy.roles[key];
  if (!allowed) return parts;
  const kept = parts.filter((m) => allowed.includes(modelKey(m)));
  return kept.length ? kept : [...allowed];
}

export function read(planDir) {
  try { return JSON.parse(fs.readFileSync(`${planDir}/ROUND_MODELS`, 'utf8')) || {}; } catch { return {}; }
}
const codexId = (v) => (v.startsWith('codex-') ? CODEX[v.slice(6)] || null : /^gpt-[\w.-]+$/.test(v) ? v : null);

// One key -> { set, codex, claude, kinds }: codex = the Codex model id or null, claude = opus|sonnet|fable|haiku or
// null, kinds = orchestrator kinds in the order written (codex -> luna, sonnet, pi, luna). set=false: no entry.
export function spec(rm, key, { strict = false, policy = readPolicy() } = {}) {
  const v = choices(rm, key, { strict, policy }).join('|');
  const out = { set: !!policy, codex: null, claude: null, kinds: [], note: '' };
  if (typeof v !== 'string' || !v.trim()) return out;
  const noTerra = PREMIUM_KEYS.has(key);
  let parts = v.split('|').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (noTerra) {
    const kept = parts.filter((a) => codexId(a) !== CODEX.terra);
    if (kept.length !== parts.length) {
      out.note = `${CODEX.terra} is not allowed for ${key} - rounds and workers only - using ${kept.length ? kept.join(' or ') : CODEX.sol}`;
      parts = kept.length ? kept : policy ? [] : ['codex-sol'];
    }
  }
  for (const a of parts) {
    const c = codexId(a);
    if (c) { out.codex ||= c; out.kinds.push('luna'); continue; }
    if (CLAUDE.has(a)) { out.claude ||= a; if (a === 'sonnet' || policy) out.kinds.push(policy && key === 'rounds' ? 'sonnet' : a); continue; }
    if (a === 'luna') { out.codex ||= CODEX.luna; out.kinds.push('luna'); continue; }
    if (a === 'pi' || (policy && WORKER_ONLY.has(modelKey(a)))) { out.kinds.push(a); continue; }
  }
  if (policy) out.kinds = [...new Set(out.kinds)];
  out.set = !!(policy || out.codex || out.claude || out.kinds.length);
  return out;
}

// Resolve a concrete launcher lane. Called before execution, including worker/free fallbacks.
// A denied lane exits 75, so existing schedulers can wait or try another allowed provider.
export function launch(rm, role, kind, { policy = readPolicy(), strict = false } = {}) {
  if (!policy && !isStrict(rm)) return { allowed: true, kind, codex: null };
  if (isStrict(rm) && ['luna', 'codex', 'codex-only', 'cloud'].includes(kind)) return { allowed: false, kind, codex: null };
  const row = !policy ? null : role === 'premium' ? choices({}, role, { policy }) : policy.roles[role];
  if (!row && !isStrict(rm)) return { allowed: true, kind, codex: null };
  const s = spec(rm, role, { policy, strict });
  if (['luna', 'codex', 'codex-only'].includes(kind)) return { allowed: !!s.codex, kind, codex: s.codex };
  if (kind === 'cloud') return { allowed: false, kind, codex: null }; // cloud launcher cannot pin a concrete model
  if (isStrict(rm)) { // strict pin: only the pinned Claude model, never Codex, free or another Claude model
    if (CLAUDE.has(kind) || kind === 'premium') return { allowed: !!s.claude, kind: s.claude || kind, codex: null };
    return { allowed: false, kind, codex: null };
  }
  if (CLAUDE.has(kind)) return { allowed: !!s.claude, kind: s.claude || kind, codex: null };
  if (kind === 'premium') return { allowed: !!(s.codex || s.claude), kind, codex: s.codex };
  return { allowed: row.includes(modelKey(kind)), kind, codex: null };
}

// CLI for the shell scripts: node round-models.mjs <planDir> <key> [--strict]  (--strict: no "premium" fallback;
// audit.sh uses it so a plan's "premium" pin keeps applying to focus/verify/final audit only, as on 2026-11-10)
// prints RM_SET=0|1 RM_CODEX='<id>' RM_CLAUDE='<name>' RM_KINDS='<k1 k2>' (shell-safe: values are [\w.-] only),
// plus RM_NOTE='...' only when the terra premium rule changed the value
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [dir, key, flag, kind, strictFlag] = process.argv.slice(2);
  if (flag === '--launch') {
    try {
      const rm = read(dir); if (key === 'rounds' && process.env.PLANS_ROUND_FALLBACK === '1' && !isStrict(rm)) delete rm.rounds;
      const result = launch(rm, key, kind, { strict: strictFlag === '--strict' });
      const safe = (v) => String(v || '').replace(/[^\w.:/@-]/g, '');
      console.log(`ROLE_KIND='${safe(result.kind)}' ROLE_CODEX='${safe(result.codex)}'`);
      process.exit(result.allowed ? 0 : 75);
    } catch (e) { console.error(e.message); process.exit(75); }
  }
  const rm = read(dir); if (key === 'rounds' && process.env.PLANS_ROUND_FALLBACK === '1' && !isStrict(rm)) delete rm.rounds;
  const s = spec(rm, key || 'premium', { strict: flag === '--strict' });
  const safe = (x) => String(x || '').replace(/[^\w. -]/g, '');
  console.log(`RM_SET=${s.set ? 1 : 0} RM_CODEX='${safe(s.codex)}' RM_CLAUDE='${safe(s.claude)}' RM_KINDS='${safe(s.kinds.join(' '))}'${s.note ? ` RM_NOTE='${safe(s.note)}'` : ''}${isStrict(rm) ? ' RM_STRICT=1' : ''}`);
}
