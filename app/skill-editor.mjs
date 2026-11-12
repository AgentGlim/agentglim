// Skill Editor API: the bundled sub-app behind /skills.
// Roots are exactly skillRoots() in skills.mjs (the same set the read-only inventory scans), so nothing is
// hardcoded to a project folder. Every read and write must resolve inside one of those skill folders.
//   GET /api/skills/list                      -> {skills:[...]}
//   GET /api/skills/usage                     -> optional $AGENTGLIM_DATA/skills-usage.json
//   GET /api/skills/file?skill=NAME&path=REL  -> {text, mtime}
//   PUT /api/skills/file?skill=NAME&path=REL  {text, base_mtime, force?} -> {mtime} or 409 {error, text, mtime}
import fs from 'node:fs';
import path from 'node:path';
import { HOME, DATA } from './paths.mjs';
import { AGENTGLIM_ROOT } from './settings.mjs';
import { skillRoots } from './skills.mjs';
import { sameAppRequest } from './open-url-rules.mjs';

const EXTS = new Set(['.md', '.txt', '.yaml', '.yml', '.json', '.toml', '.csv', '.py', '.sh', '.mjs', '.js', '.css', '.html']);
const SKIP = new Set(['node_modules', '__pycache__', '.git', '.venv', 'venv']);
const MAX_FILES = 250, MAX_BYTES = 1_000_000, MAX_DEPTH = 8, MAX_BODY = 4 * 1024 * 1024;
const GENERIC = new Set(['design', 'docs', 'pdf', 'theme', 'morning', 'docx', 'pptx', 'xlsx', 'synced']);

const textFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const skipName = (n) => n.startsWith('.') || n === 'node_modules' || n === '__pycache__' || n === '.git' || n === 'venv' || n === '.venv' || /bak|_archive/.test(n);

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const k = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (k) fm[k[1]] = k[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return fm;
}

function listFiles(base) {
  const files = [], seen = new Set();
  const walk = (dir, rel, depth) => {
    if (files.length >= MAX_FILES || depth > 4) return;
    let real; try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (skipName(e.name)) continue;
      const p = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() || (e.isSymbolicLink() && isDir(p))) walk(p, r, depth + 1);
      else if (e.isFile() || (e.isSymbolicLink() && textFile(p))) {
        if (!EXTS.has(path.extname(e.name).toLowerCase())) continue;
        try { if (fs.statSync(p).size > MAX_BYTES) continue; } catch { continue; }
        files.push(r);
        if (files.length >= MAX_FILES) return;
      }
    }
  };
  walk(base, '', 0);
  return files;
}

// One pass over the shared root list. A folder with a SKILL.md is a skill; nested skills are found the same
// way scanSkills finds them (dot folders, node_modules and bak/_archive copies are skipped).
export function discoverSkills({ home = HOME, root = AGENTGLIM_ROOT, extra } = {}) {
  const found = [], seen = new Set(), used = new Set();
  const visit = (dir, label, depth) => {
    if (depth < 0) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    let real, st; try { real = fs.realpathSync(dir); st = fs.lstatSync(dir); } catch { return; }
    if (textFile(path.join(dir, 'SKILL.md'))) {
      if (seen.has(real)) return;
      seen.add(real);
      const short = path.basename(dir);
      let name = short;
      if (used.has(name)) name = `${label.toLowerCase().replace(/\s+/g, '-')}:${short}`;
      for (let n = 2; used.has(name); n++) name = `${label.toLowerCase().replace(/\s+/g, '-')}:${short}-${n}`;
      used.add(name);
      const project = /project$/i.test(label) ? 'project' : /^bundled$/i.test(label) ? 'bundled' : '';
      found.push({ name, short, label, dir: real, link: st.isSymbolicLink(), scope: project ? 'project' : 'global', project });
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (skipName(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory() || (e.isSymbolicLink() && isDir(p))) visit(p, label, depth - 1);
    }
  };
  for (const [label, dir] of skillRoots({ home, root, extra })) visit(dir, label, MAX_DEPTH);
  return found;
}

const KINDS = [ // first match wins; checked against the sentence around the reference
  ['contrast', /\b(not|never|instead|unlike|rather than|don't|avoid)\b/i],
  ['routes', /\b(route[sd]?|router|hand(s|ed)? ?off|handoff|pick(s|ed)?|chain|sub-skills?|then|->)\b|→/i],
  ['reads', /\b(read|reads|load|loads|follow|follows|SKILL\.md)\b/i],
  ['runs', /\b(run|runs|invoke[sd]?|call|calls|use|uses|exports? to|launch)\b/i],
];

function classify(text, start, end, to) {
  const a = Math.max(text.lastIndexOf('\n', start), text.lastIndexOf('. ', start));
  const ends = [text.indexOf('\n', end), text.indexOf('. ', end)].filter((i) => i !== -1);
  const b = ends.length ? Math.min(...ends) : text.length;
  const ctx = text.slice(a + 1, b).trim().slice(0, 200);
  if (text[end] === '/') return { to, kind: 'files', label: 'uses files of', ctx };
  for (const [kind, rx] of KINDS) if (rx.test(ctx)) return { to, kind, label: kind, ctx };
  return { to, kind: 'mentions', label: 'mentions', ctx };
}

const WORDC = /[\w-]/;

function references(skills, texts) {
  const byShort = new Map();
  for (const s of skills) { if (!byShort.has(s.short)) byShort.set(s.short, []); byShort.get(s.short).push(s.name); }
  for (const s of skills) {
    const text = texts.get(s.name) || '', exp = new Map(), plan = new Map(), refs = [], links = [];
    for (const m of text.matchAll(/[\w-]+/g)) {
      const token = m[0], i = m.index;
      for (const other of byShort.get(token) || []) {
        if (other === s.name || exp.has(other)) continue;
        const p = i > 0 ? text[i - 1] : '', prev = i > 1 ? text[i - 2] : ' ';
        if (((p === '/' || p === '$') && !WORDC.test(prev)) || p === '`' || text.slice(0, i).endsWith('skills/')) exp.set(other, i);
        else if (!plan.has(other) && p !== '/' && p !== '.' && !GENERIC.has(token)) plan.set(other, i);
      }
    }
    for (const other of skills) {
      const i = exp.has(other.name) ? exp.get(other.name) : plan.get(other.name);
      if (i != null && other.name !== s.name) { refs.push(other.name); links.push(classify(text, i, i + other.short.length, other.name)); }
    }
    s.refs = refs; s.links = links;
  }
}

function variants(skills) {
  const out = [];
  for (const a of skills) for (const b of skills) {
    if (a.short.includes(':') || b.short.includes(':') || a.short >= b.short) continue;
    if (b.short.startsWith(`${a.short}-`) || a.short.startsWith(`${b.short}-`) ||
      (a.short.split('-').pop() === b.short.split('-').pop() && a.short.split('-').length === 2 && b.short.split('-').length === 2 && ['review', 'analyzer'].includes(a.short.split('-').pop()))) out.push([a, b]);
  }
  return out;
}

export function skillsPayload({ home = HOME, root = AGENTGLIM_ROOT, extra } = {}) {
  const found = discoverSkills({ home, root, extra }), texts = new Map(), out = [];
  for (const s of found) {
    let text = ''; try { text = fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8'); } catch {}
    texts.set(s.name, text);
    const fm = frontmatter(text);
    const show = (p) => String(p).replace(home, '~').replace(root, '~');
    out.push({
      name: s.name, short: s.short,
      root: s.label.toLowerCase().replace(/\s+/g, '-'),
      scope: s.scope, project: s.project, link: s.link, dir: show(s.dir),
      description: fm.description || '',
      manual: String(fm['disable-model-invocation'] || '').toLowerCase() === 'true',
      lines: text ? text.split('\n').length : 0,
      files: listFiles(s.dir), refs: [], links: [],
      tags: [],
      agents: {
        claude: textFile(path.join(home, '.claude', 'skills', s.short, 'SKILL.md')),
        codex: textFile(path.join(home, '.codex', 'skills', s.short, 'SKILL.md')),
      },
    });
  }
  references(out, texts);
  const byName = new Map(out.map((s) => [s.name, s]));
  for (const [a, b] of variants(out)) {
    if (!byName.get(a.name).refs.includes(b.name) && !byName.get(b.name).refs.includes(a.name))
      byName.get(a.name).links.push({ to: b.name, kind: 'variant', label: 'variant of', ctx: 'similar name' });
  }
  return out.sort((a, b) => a.short.localeCompare(b.short) || a.name.localeCompare(b.name));
}

// A resolved path must already exist, stay inside its skill folder, and be an editable text file.
export function resolveSkillFile(skill, rel, { home = HOME, root = AGENTGLIM_ROOT, extra } = {}) {
  if (typeof skill !== 'string' || typeof rel !== 'string' || !skill || !rel || rel.length > 4096 || rel.includes('\0')) return null;
  const found = discoverSkills({ home, root, extra }).find((s) => s.name === skill);
  if (!found) return null;
  let base, p;
  try { base = fs.realpathSync(found.dir); p = fs.realpathSync(path.join(base, rel)); } catch { return null; }
  if (p !== base && !p.startsWith(base + path.sep)) return null;
  if (!EXTS.has(path.extname(p).toLowerCase()) || !textFile(p)) return null;
  return p;
}

const mtimeOf = (p) => String(fs.statSync(p, { bigint: true }).mtimeNs);
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

function usage(data) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(data, 'skills-usage.json'), 'utf8'));
    if (j && typeof j === 'object' && j.skills && typeof j.skills === 'object') return { ok: true, ...j };
  } catch {}
  return { ok: false, skills: {} };
}

// Same guards as every other write in this app: local Host, the page's own Origin, same-origin fetch.
const sameOrigin = (req) => sameAppRequest(req.headers) && req.headers.origin === `http://${req.headers.host}` && req.headers['sec-fetch-site'] !== 'cross-site';

function readBody(req) {
  return new Promise((resolve) => {
    let body = '', over = false;
    req.on('data', (c) => { if (over) return; body += c; if (body.length > MAX_BODY) { over = true; body = ''; req.destroy(); } });
    req.on('end', () => resolve(over ? null : body));
  });
}

export async function skillEditorRoute(req, res, route, { home = HOME, root = AGENTGLIM_ROOT, data = DATA, extra } = {}) {
  if (!route.startsWith('/api/skills/')) return false;
  const url = new URL(req.url, 'http://x');
  if (route === '/api/skills/list') {
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' }), true;
    return json(res, 200, { skills: skillsPayload({ home, root, extra }) }), true;
  }
  if (route === '/api/skills/usage') {
    if (req.method !== 'GET') return json(res, 405, { error: 'GET only' }), true;
    return json(res, 200, usage(data)), true;
  }
  if (route === '/api/skills/file') {
    const skill = url.searchParams.get('skill') || '', rel = url.searchParams.get('path') || '';
    if (req.method === 'GET') {
      const p = resolveSkillFile(skill, rel, { home, root, extra });
      if (!p) return json(res, 404, { error: 'not found' }), true;
      try { return json(res, 200, { text: fs.readFileSync(p, 'utf8'), mtime: mtimeOf(p) }), true; }
      catch { return json(res, 404, { error: 'not found' }), true; }
    }
    if (req.method === 'PUT') {
      if (!sameOrigin(req) || !/json/i.test(String(req.headers['content-type'] || ''))) return json(res, 403, { error: 'forbidden' }), true;
      const p = resolveSkillFile(skill, rel, { home, root, extra });
      if (!p) return json(res, 404, { error: 'not found' }), true;
      const raw = await readBody(req);
      if (raw == null) return json(res, 413, { error: 'too large' }), true;
      let body; try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: 'bad json' }), true; }
      if (typeof body.text !== 'string' || body.text.length > MAX_BYTES) return json(res, 422, { error: 'text required' }), true;
      const cur = mtimeOf(p);
      if (!body.force && String(body.base_mtime ?? '') !== cur) {
        let text = ''; try { text = fs.readFileSync(p, 'utf8'); } catch {}
        return json(res, 409, { error: 'changed on disk', text, mtime: cur }), true;
      }
      const tmp = path.join(path.dirname(p), `.agentglim-skills-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      try {
        fs.writeFileSync(tmp, body.text, { encoding: 'utf8', mode: fs.statSync(p).mode & 0o777 });
        fs.renameSync(tmp, p);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        return json(res, 500, { error: 'write failed' }), true;
      }
      return json(res, 200, { mtime: mtimeOf(p) }), true;
    }
    return json(res, 405, { error: 'GET or PUT only' }), true;
  }
  return false;
}
