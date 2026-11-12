// update-check.mjs: tells the app when a newer public release exists.
// The running version comes from app/version.json: "dev" in the private repo, the release tag in an export
// (dev/stamp-version.mjs writes it during release). The check is one plain GET to the public GitHub API,
// at most once every 12 hours, cached in $AGENTGLIM_DATA/update-check.json. It sends no user data and no token.
// Opt out with updateCheck:false in integrations.json or AGENTGLIM_NO_UPDATE_CHECK=1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION_FILE = path.join(HERE, 'version.json');
export const DEFAULT_API_BASE = 'https://api.github.com/repos/AgentGlim/agentglim';
export const RELEASES_URL = 'https://github.com/AgentGlim/agentglim/releases';
export const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const CACHE_FILE = 'update-check.json';
const USER_AGENT = 'agentglim-update-check';
const RELEASE_TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)/i;

export function normalizeVersion(value) {
  const m = String(value || '').trim().match(RELEASE_TAG_RE);
  return m ? `v${m[1]}.${m[2]}.${m[3]}` : null;
}

export function compareVersions(a, b) {
  const pa = String(a || '').trim().replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || '').trim().replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// The private repo ships "dev"; a release export carries its tag. A malformed file is "dev", never a banner.
export function currentVersion(file = VERSION_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return normalizeVersion(parsed?.version) || 'dev';
  } catch {
    return 'dev';
  }
}

export function updateCheckEnabled({ integrations = {}, env = process.env } = {}) {
  if (String(env?.AGENTGLIM_NO_UPDATE_CHECK || '').trim() === '1') return false;
  return integrations?.updateCheck !== false;
}

export function cachePath(data) {
  return path.join(data, CACHE_FILE);
}

export function readCache(data) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(data), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const latest = normalizeVersion(parsed.latest);
    return {
      checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : null,
      latest,
      url: typeof parsed.url === 'string' && /^https:\/\/github\.com\//.test(parsed.url) ? parsed.url : null,
      ok: parsed.ok === true,
    };
  } catch {
    return null;
  }
}

function writeCache(data, entry) {
  try {
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(cachePath(data), JSON.stringify(entry, null, 2) + '\n');
  } catch {}
}

function cacheIsFresh(cache, now) {
  const at = Date.parse(cache?.checkedAt || '');
  return Number.isFinite(at) && now - at >= 0 && now - at < CHECK_INTERVAL_MS;
}

function howTo(latest) {
  return {
    git: 'git pull',
    tarball: latest
      ? `curl -L https://github.com/AgentGlim/agentglim/archive/refs/tags/${latest}.tar.gz -o agentglim-${latest}.tar.gz && tar -xzf agentglim-${latest}.tar.gz`
      : null,
    restart: 'Restart AgentGlim after updating.',
  };
}

// Shape of GET /api/version. Latest stays hidden for dev builds and when the check is off.
export function statusFrom({ current, cache = null, enabled = true, now = Date.now() } = {}) {
  const cur = normalizeVersion(current) || 'dev';
  const on = enabled !== false;
  const latest = cache?.latest || null;
  const updateAvailable = on && cur !== 'dev' && !!latest && compareVersions(latest, cur) > 0;
  return {
    current: cur,
    latest: on && cur !== 'dev' ? latest : null,
    updateAvailable,
    checkedAt: cache?.checkedAt || null,
    url: updateAvailable && cache?.url ? cache.url : latest ? `${RELEASES_URL}/tag/${latest}` : RELEASES_URL,
    howTo: howTo(latest),
    enabled: on,
  };
}

// Read-only view from the cached file; used by the server before a new check finishes.
export function versionStatus({ data, current, enabled = true, now = Date.now() } = {}) {
  return statusFrom({ current, cache: readCache(data), enabled, now });
}

async function fetchLatest(apiBase, fetchImpl) {
  const base = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, '');
  const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(8000) : undefined;
  const get = async (suffix) => {
    const res = await fetchImpl(`${base}${suffix}`, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
      signal,
    });
    if (!res || !res.ok) throw new Error(`HTTP ${res?.status || 'error'}`);
    return res.json();
  };
  try {
    const release = await get('/releases/latest');
    const latest = normalizeVersion(release?.tag_name);
    if (latest) {
      const url = typeof release?.html_url === 'string' && /^https:\/\/github\.com\//.test(release.html_url)
        ? release.html_url : `${RELEASES_URL}/tag/${latest}`;
      return { latest, url };
    }
  } catch {}
  // Releases can be absent or rate-limited; tags are a smaller fallback.
  try {
    const tags = await get('/tags');
    const latest = Array.isArray(tags) ? normalizeVersion(tags.find((t) => t && t.name)?.name) : null;
    if (latest) return { latest, url: `${RELEASES_URL}/tag/${latest}` };
  } catch {}
  return { latest: null, url: null };
}

// Fetch only when the cache is older than 12 h. Failures are cached too, so an offline machine stays quiet.
export async function checkForUpdate({
  data, current, enabled = true, apiBase = process.env.AGENTGLIM_UPDATE_API, fetchImpl = fetch,
  now = Date.now(), force = false,
} = {}) {
  const cur = normalizeVersion(current) || 'dev';
  const on = enabled !== false;
  const cache = readCache(data);
  if (!on || cur === 'dev') return statusFrom({ current: cur, cache, enabled: on, now });
  if (!force && cacheIsFresh(cache, now)) return statusFrom({ current: cur, cache, enabled: on, now });

  const found = await fetchLatest(apiBase, fetchImpl);
  // A failed refresh must not erase a known release; it only moves the next attempt 12 h out.
  const latest = found.latest || cache?.latest || null;
  const url = found.url || cache?.url || null;
  const entry = { checkedAt: new Date(now).toISOString(), latest, url, ok: !!found.latest };
  writeCache(data, entry);
  return statusFrom({ current: cur, cache: entry, enabled: on, now });
}
