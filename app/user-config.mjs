// user-config.mjs: the owner's own names and rules, read from $AGENTGLIM_DATA/setup.json.
// Nothing here has a built-in value: a fresh install ships no client names, no private skill
// prefixes, no project icon overrides and no extra host alias. Every key is optional; a missing,
// empty or malformed value means "no extras", the same way owner-attention.mjs reads clientKeywords.
//   clientKeywords    (read in owner-attention.mjs, unchanged) extra names for the "clients" area
//   skillPrefixes     {"<category id>": ["acme-", ...]}: a skill id starting with one of these joins that category
//   projectIcons      {"<project name>": {"kind": "agents", "path": "M12 3..."}}: icon for an other-projects row
//   hostAliases       ["observatory"]: extra Host-header name this listener also answers (never a shipped default)
import fs from 'node:fs';
import { DATA } from './paths.mjs';

const KINDS = new Set(['ai', 'agents', 'video', 'business', 'devtools', 'personal']);
const cache = new Map();

function setup(dataDir = DATA) {
  let st; try { st = fs.statSync(`${dataDir}/setup.json`); } catch { return {}; }
  const hit = cache.get(dataDir);
  if (hit && hit.m === st.mtimeMs) return hit.cfg;
  let cfg; try { cfg = JSON.parse(fs.readFileSync(`${dataDir}/setup.json`, 'utf8')); } catch { cfg = {}; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  cache.set(dataDir, { m: st.mtimeMs, cfg });
  return cfg;
}

const strings = (v, max) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string')
  .map((x) => x.trim()).filter(Boolean).slice(0, max);

// Host names the owner added for this app; loopback names are built in and never come from here.
export function cleanAliases(raw) {
  return strings(raw, 20).map((n) => n.toLowerCase().replace(/:\d+$/, ''))
    .filter((n) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(n));
}
export function hostAliases(dataDir = DATA) { return cleanAliases(setup(dataDir).hostAliases); }

// Skill id prefixes per category, e.g. {"auto": ["acme-"]}: plain prefixes, not regular expressions.
export function cleanPrefixes(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [cat, list] of Object.entries(raw)) {
    if (!/^[a-z0-9-]{1,20}$/.test(cat)) continue;
    const prefixes = strings(list, 20).map((p) => p.replace(/^\^/, ''))
      .filter((p) => /^[a-z0-9][a-z0-9_-]{0,30}$/.test(p));
    if (prefixes.length) out[cat] = [...new Set(prefixes)];
  }
  return out;
}
export function skillPrefixes(dataDir = DATA) { return cleanPrefixes(setup(dataDir).skillPrefixes); }

// The same prefixes as a regex suffix ("|^acme-|^x-"), for a built-in category rule. Empty when none.
export function prefixSuffix(category, dataDir = DATA) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const list = skillPrefixes(dataDir)[category] || [];
  return list.map((p) => `|^${esc(p)}`).join('');
}

// Per-project icon overrides for the other-projects rows: simple SVG shape markup drawn like the built-in
// icons, plus an optional icon kind. Anything that is not a plain shape (scripts, event handlers, images,
// foreign objects) is dropped, so a config file can never inject code into the dashboard.
const SVG_TAGS = new Set(['path', 'circle', 'rect', 'line', 'polygon', 'polyline', 'ellipse']);
const SVG_ATTRS = new Set(['d', 'cx', 'cy', 'r', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'width', 'height', 'rx', 'ry',
  'points', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule']);
const TAG = /^<([a-z]+)((?:\s+[a-z][a-z-]*="[^"<>]*")*)\s*\/>$/;
export function safeShape(s) {
  if (typeof s !== 'string' || !s || s.length > 2000) return null;
  const tags = s.match(/<[^<>]*\/>/g);
  if (!tags || tags.join('') !== s) return null;
  for (const t of tags) {
    const m = TAG.exec(t);
    if (!m || !SVG_TAGS.has(m[1])) return null;
    for (const a of m[2].matchAll(/([a-z][a-z-]*)="([^"]*)"/g)) {
      if (!SVG_ATTRS.has(a[1]) || !/^[A-Za-z0-9 .,#%()-]*$/.test(a[2])) return null;
    }
  }
  return s;
}

export function cleanIcons(raw) {
  const paths = {}, kinds = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { paths, kinds };
  for (const [name, spec] of Object.entries(raw)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(name)) continue;
    const s = typeof spec === 'string' ? { path: spec } : spec;
    if (!s || typeof s !== 'object') continue;
    const shape = safeShape(s.path);
    if (shape) paths[name] = shape;
    if (typeof s.kind === 'string' && KINDS.has(s.kind)) kinds[name] = s.kind;
  }
  return { paths, kinds };
}
export function projectIcons(dataDir = DATA) { return cleanIcons(setup(dataDir).projectIcons); }
