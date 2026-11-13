// free-models.mjs: which Jev routing options a launch may consider.
// Hosted free models belong only in autonomous project workers: every launch that is not explicitly a
// plan-loop worker (jev-route.mjs --plan-worker) gets a strict allowlist (Claude, Codex, DeepSeek Flash).
// Anything else (free, local, unknown) is refused, so a free tier is never spent on unreviewed interactive work.
export const NON_WORKER_GROUPS = new Set(['claude', 'codex']);
export const NON_WORKER_IDS = new Set(['deepseek-flash']);

export function isFreeModel(value) {
  const s = String(value || '').toLowerCase();
  return /(?:^|[\s/])(?:opencode-free|gofree:|zen:|free3(?:[\s/:_-]|$)|groq(?:[\s/:_-]|$)|gai(?:[\s/:_-]|$)|cfai(?:[\s/:_-]|$)|pi-or(?:\s|$))/.test(s)
    || /-free(?:$|[^a-z0-9])/.test(s) || /:free(?:$|[^a-z0-9])/.test(s);
}

export function isNonWorkerAllowed(rules, id) {
  const option = rules.options?.[id];
  if (!option || isFreeModel(id) || isFreeModel(option.launch)) return false;
  return NON_WORKER_IDS.has(id) || (NON_WORKER_GROUPS.has(option.group) && /^(claude|codex)-/.test(id));
}

// Non-worker pool (the default everywhere): allowlist only.
export function nonFreeOptions(rules, ids = Object.keys(rules.options)) {
  return ids.filter((id) => isNonWorkerAllowed(rules, id));
}

// worker = true only for an explicit plan-loop worker; free models may be offered there.
export function poolFor(rules, ids = Object.keys(rules.options), worker = false) {
  return worker ? ids.filter((id) => rules.options?.[id]) : nonFreeOptions(rules, ids);
}
