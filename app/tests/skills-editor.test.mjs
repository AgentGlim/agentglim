// Skill Editor API (bundled sub-app): every test runs against a temp HOME fixture, never the real one.
import { waitForServerReady } from './helpers/server-ready.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-skills-editor-'));
  const write = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  write('env', '');
  write('harness.json', '{}');
  write('.agents/skills/alpha-skill/SKILL.md', '---\nname: alpha-skill\ndescription: Fixture skill that hands work to beta.\n---\n\n# Alpha\n\nUse beta-skill for the review pass. Never edit the archive.\n');
  write('.agents/skills/alpha-skill/notes/extra.md', 'extra notes\n');
  write('.agents/skills/alpha-skill/.hidden/ignored.md', 'not listed\n');
  write('.agents/skills/alpha-skill/blob.bin', 'not editable\n');
  write('.agents/skills/beta-skill/SKILL.md', '---\nname: beta-skill\ndescription: Fixture review helper.\n---\n\n# Beta\n');
  write('.codex/skills/beta-skill/SKILL.md', '---\nname: beta-skill\ndescription: Codex copy of the review helper.\n---\n\n# Beta\n');
  write('custom-skills/gamma-skill/SKILL.md', '---\nname: gamma-skill\ndescription: Added through the extra-roots setting.\n---\n\n# Gamma\n');
  write('secret.txt', 'do not serve this\n');
  fs.symlinkSync(path.join(home, 'secret.txt'), path.join(home, '.agents', 'skills', 'alpha-skill', 'escape.md'));
  return home;
}

async function server(t, home) {
  const child = spawn(process.execPath, ['app/server.mjs', '0'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_ENV_FILE: path.join(home, 'env'),
      AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_PLANS: path.join(home, 'plans'),
      AGENTGLIM_SKILL_ROOTS: path.join(home, 'custom-skills'), AGENTGLIM_DEV: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'exit'); fs.rmSync(home, { recursive: true, force: true }); });
  const port = await waitForServerReady(child);
  return `http://127.0.0.1:${port}`;
}

const getJson = async (url) => { const r = await fetch(url); return { status: r.status, body: await r.json() }; };

test('Skill Editor serves the bundled page and lists only fixture skills', async (t) => {
  const home = fixture();
  const base = await server(t, home);
  const page = await (await fetch(base + '/skills')).text();
  assert.match(page, /<title>Skills · AgentGlim<\/title>/);
  assert.match(page, /\/api\/skills\/list/);
  assert.doesNotMatch(page, /__USAGE__|tags\.json|playwright/);

  const { status, body } = await getJson(base + '/api/skills/list');
  assert.equal(status, 200);
  const names = body.skills.map((s) => s.name);
  for (const name of ['alpha-skill', 'beta-skill', 'codex:beta-skill', 'gamma-skill']) assert.ok(names.includes(name), `lists ${name}`);
  const alpha = body.skills.find((s) => s.name === 'alpha-skill');
  assert.equal(alpha.description, 'Fixture skill that hands work to beta.');
  assert.equal(alpha.root, 'agents');
  assert.equal(alpha.scope, 'global');
  assert.ok(alpha.files.includes('SKILL.md') && alpha.files.includes('notes/extra.md'));
  assert.ok(!alpha.files.some((f) => f.includes('.hidden') || f.endsWith('.bin')));
  const link = alpha.links.find((l) => l.to === 'beta-skill');
  assert.ok(link && link.kind === 'runs', `classifies the cross-reference (${JSON.stringify(alpha.links)})`);
  assert.ok(body.skills.every((s) => s.dir.startsWith('~')), 'shown paths stay relative to HOME');
  assert.ok(!JSON.stringify(body).includes(home), 'the fixture home path is never sent');
  assert.ok(!body.skills.some((s) => s.dir.startsWith(process.env.HOME)), 'the real HOME is never scanned');
});

test('Skill Editor reads, saves, reports stale mtimes and refuses escapes and cross-origin writes', async (t) => {
  const home = fixture();
  const base = await server(t, home);
  const skillFile = `${base}/api/skills/file?skill=alpha-skill&path=SKILL.md`;
  const origin = { origin: base, 'content-type': 'application/json' };

  const read = await getJson(skillFile);
  assert.equal(read.status, 200);
  assert.match(read.body.text, /Fixture skill that hands work to beta/);
  assert.equal(typeof read.body.mtime, 'string');

  const changed = read.body.text.replace('# Alpha', '# Alpha edited');
  const saved = await fetch(skillFile, { method: 'PUT', headers: origin, body: JSON.stringify({ text: changed, base_mtime: read.body.mtime }) });
  assert.equal(saved.status, 200);
  const savedMtime = (await saved.json()).mtime;
  assert.notEqual(savedMtime, read.body.mtime);
  assert.match(fs.readFileSync(path.join(home, '.agents/skills/alpha-skill/SKILL.md'), 'utf8'), /# Alpha edited/);

  const stale = await fetch(skillFile, { method: 'PUT', headers: origin, body: JSON.stringify({ text: 'stale write', base_mtime: read.body.mtime }) });
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.match(conflict.text, /# Alpha edited/, 'a conflict returns the current disk text');
  assert.equal(conflict.mtime, savedMtime);
  assert.match(fs.readFileSync(path.join(home, '.agents/skills/alpha-skill/SKILL.md'), 'utf8'), /# Alpha edited/);

  const forced = await fetch(skillFile, { method: 'PUT', headers: origin, body: JSON.stringify({ text: 'forced write\n', base_mtime: read.body.mtime, force: true }) });
  assert.equal(forced.status, 200);

  for (const bad of ['../../secret.txt', '..%2F..%2Fsecret.txt', path.join(home, 'secret.txt'), 'escape.md', 'blob.bin']) {
    const res = await fetch(`${base}/api/skills/file?skill=alpha-skill&path=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 404, `refuses ${bad}`);
  }
  assert.equal((await fetch(`${base}/api/skills/file?skill=../alpha-skill&path=SKILL.md`)).status, 404);
  assert.equal((await fetch(`${base}/api/skills/file?skill=missing&path=SKILL.md`)).status, 404);

  const body = JSON.stringify({ text: 'x', base_mtime: savedMtime });
  assert.equal((await fetch(skillFile, { method: 'PUT', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(skillFile, { method: 'PUT', headers: { 'content-type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(skillFile, { method: 'PUT', headers: { origin: base, 'content-type': 'text/plain' }, body })).status, 403);
  assert.equal((await fetch(skillFile, { method: 'POST', headers: origin, body })).status, 405);

  const usage = await getJson(base + '/api/skills/usage');
  assert.deepEqual(usage.body, { ok: false, skills: {} });
  fs.writeFileSync(path.join(home, 'data/skills-usage.json'), JSON.stringify({ generated: '2026-01-01', skills: { 'alpha-skill': { total: 3 } } }));
  assert.deepEqual((await getJson(base + '/api/skills/usage')).body, { ok: true, generated: '2026-01-01', skills: { 'alpha-skill': { total: 3 } } });
});

// Source checks (no server): the Skills entry point sits in the header, keeps its own accent at WCAG AA in both
// themes, and the tour points at it there.
test('Skills is a top-level header button with its own accent token, and the tour step follows it', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const steps = JSON.parse(fs.readFileSync(new URL('../walkthrough-steps.json', import.meta.url), 'utf8'));
  const header = /<div class="hdr-r">([\s\S]*?)<\/header>/.exec(html);
  assert.ok(header, 'the header right-hand control group is found');
  assert.match(header[1], /<a class="btn skills-btn" id="skillsLink" href="\/skills"/, 'Skills is a header button next to Setup (integrations.mjs still overrides this href)');
  const menu = /<details class="pgmenu" id="pgMenu">([\s\S]*?)<\/nav><\/details>/.exec(html);
  assert.ok(menu, 'the Pages menu is found');
  assert.doesNotMatch(menu[1], /id="skillsLink"/, 'Skills left the Pages menu');
  assert.match(html, /a\.btn\.skills-btn\{[^}]*color:var\(--skills-accent\)/, 'the button uses the token for its text');
  assert.match(html, /header\{[^}]*background:var\(--header-bg\)/, 'the header paints the surface the accent sits on');

  // The accent must pass WCAG AA (4.5:1 for normal text) on the header surface in both themes.
  const token = (css, re) => (/[#][0-9a-f]{6}/i.exec(re.exec(css)[1]) || [])[0];
  const dark = { accent: token(html, /--skills-accent:(#[0-9a-f]{6})/i), bg: token(html, /--bg:(#[0-9a-f]{6})/i) };
  const lightRule = /html\[data-theme="light"\]\{([^}]*)\}/.exec(html)[1];
  const light = { accent: token(lightRule, /--skills-accent:(#[0-9a-f]{6})/i), bg: token(lightRule, /--header-bg:(#[0-9a-f]{6})/i) };
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  for (const [name, t] of Object.entries({ dark, light })) {
    assert.match(t.accent, /^#[0-9a-f]{6}$/i, `${name} accent token`);
    assert.match(t.bg, /^#[0-9a-f]{6}$/i, `${name} header surface token`);
    assert.ok(ratio(t.accent, t.bg) >= 4.5, `${name} accent ${t.accent} on ${t.bg} is AA (${ratio(t.accent, t.bg).toFixed(2)}:1)`);
  }

  const step = steps.steps.find((s) => s.id === 'skills');
  assert.equal(step?.target, '#skillsLink', 'the tour step points at the new header button');
  assert.match(step.body, /header button/, 'the step says it is a header button');
});
