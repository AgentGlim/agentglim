// Skills to retire: recommendation rules and the live /api/skills/retire payload.
// Every fixture lives in a temp HOME; nothing here reads the owner's real skills, usage or data folder.
import { waitForServerReady } from './helpers/server-ready.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { buildRetireData, retirePayload } from '../skills-retire.mjs';

const TODAY = Date.parse('2026-11-12T00:00:00Z');
const copy = (hash, over = {}) => ({ label: 'global', dir: '~/.agents/skills/x', lines: 5, hash, mtime: '2026-01-01', born: '2025-01-01', delta: 0, ...over });
const skill = (id, over = {}) => ({ id, desc: `${id} fixture skill.`, cat: 'other', copies: [copy('aaaa')], out: {}, inn: {}, ...over });

test('retire rules: remove, merge, blocked, mentions and diverged copies', () => {
  const usage = {
    range: { claude: { from: '2026-10-01', to: '2026-11-06' } },
    skills: {
      'parent-skill': { total: 6, last: '2026-11-04' },
      'parent-skill-lookup': { total: 2, last: '2026-11-02' },
      'caller-skill': { total: 3, last: '2026-11-03' },
      'diverged-skill': { total: 2, last: '2026-10-30' },
    },
  };
  const skills = [
    skill('old-skill'),
    skill('parent-skill'),
    skill('parent-skill-lookup', { copies: [copy('bbbb')] }),
    skill('caller-skill'),
    skill('blocked-skill', { inn: { 'caller-skill': 'runs' } }),
    skill('mention-skill', { inn: { 'caller-skill': 'mentions' } }),
    skill('diverged-skill', { copies: [copy('cccc', { delta: 0 }), copy('dddd', { label: 'codex', delta: 2 })] }),
  ];
  const data = buildRetireData({ skills, usage, notes: { skills: { 'old-skill': { what: 'Owner note for old.' } } }, today: TODAY });
  const by = Object.fromEntries(data.skills.map((s) => [s.id, s]));

  assert.equal(data.logFrom, '2026-10-01');
  assert.equal(data.logDays, 42);
  assert.equal(by['old-skill'].group, 'remove');
  assert.equal(by['old-skill'].what, 'Owner note for old.');
  assert.match(by['old-skill'].reason, /no other skill calls it/);
  assert.equal(by['parent-skill'].group, 'keep');
  assert.equal(by['parent-skill-lookup'].group, 'merge');
  assert.equal(by['parent-skill-lookup'].into, 'parent-skill');
  assert.match(by['parent-skill-lookup'].reason, /Fold anything unique into parent-skill/);
  assert.equal(by['blocked-skill'].group, 'watch');
  assert.equal(by['blocked-skill'].safe, 'blocked');
  assert.match(by['blocked-skill'].reason, /break that link/);
  assert.equal(by['mention-skill'].safe, 'check');
  assert.equal(by['diverged-skill'].group, 'merge');
  assert.match(by['diverged-skill'].reason, /2 copies differ/);
  assert.deepEqual(data.counts, { remove: 2, merge: 2, watch: 2, keep: 1 }, 'old-skill and mention-skill are remove candidates; a mention does not block removal');
});

test('retire rules: falls back to per-skill days for the log window and still works with no usage', () => {
  const onlyDays = buildRetireData({
    skills: [skill('quiet-skill')],
    usage: { skills: { 'quiet-skill': { total: 0, days: { '2026-11-01': 2, '2026-10-20': 1 } } } },
    today: TODAY,
  });
  assert.equal(onlyDays.logFrom, '2026-10-20');
  assert.deepEqual(onlyDays.skills[0].weeks, [0, 0, 0, 0, 1, 0, 2, 0]);

  const empty = buildRetireData({ skills: [skill('quiet-skill')], usage: {}, today: TODAY });
  assert.equal(empty.logFrom, null);
  assert.equal(empty.logDays, null);
  assert.match(empty.skills[0].reason, /in the usage log/);
  assert.equal(empty.skills[0].weeks, null);
});

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-skills-retire-'));
  const write = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
  write('env', '');
  write('harness.json', '{}');
  write('.agents/skills/alpha-skill/SKILL.md', '---\nname: alpha-skill\ndescription: Alpha fixture hands work to beta.\n---\n\nUse beta-skill for the review pass.\n');
  write('.codex/skills/alpha-skill/SKILL.md', '---\nname: alpha-skill\ndescription: Alpha fixture hands work to beta.\n---\n\nUse beta-skill for the review pass.\nExtra line.\n');
  write('.agents/skills/beta-skill/SKILL.md', '---\nname: beta-skill\ndescription: Beta fixture review helper.\n---\n\n# Beta\n');
  write('.agents/skills/gamma-skill/SKILL.md', '---\nname: gamma-skill\ndescription: Gamma fixture skill.\n---\n\n# Gamma\n');
  write('data/skills-usage.json', JSON.stringify({
    generated: '2026-11-06T00:00:00Z',
    range: { claude: { from: '2026-10-01', to: '2026-11-06' } },
    skills: {
      'beta-skill': { total: 4, calls: 2, typed: 1, loads: 1, agents: { claude: 4 }, last: '2026-11-01' },
      'alpha-skill': { total: 0, last: null },
    },
  }));
  write('data/skills-retire.json', JSON.stringify({ skills: { 'beta-skill': { what: 'Owner note for beta.' } } }));
  return home;
}

test('retire payload reads live skills and usage from a temp HOME, without shipping owner data', () => {
  const home = fixture();
  try {
    const data = retirePayload({ home, root: path.join(home, 'agentglim-root'), data: path.join(home, 'data'), today: TODAY });
    const by = Object.fromEntries(data.skills.map((s) => [s.id, s]));
    assert.equal(data.skillsTotal, 3);
    assert.equal(data.copiesTotal, 4);
    assert.deepEqual(data.counts, { remove: 0, merge: 1, watch: 1, keep: 1 });
    assert.equal(by['beta-skill'].group, 'keep');
    assert.equal(by['beta-skill'].what, 'Owner note for beta.');
    assert.equal(by['alpha-skill'].diverged, true);
    assert.deepEqual(by['alpha-skill'].copies.map((c) => c.label).sort(), ['codex', 'global']);
    assert.match(by['alpha-skill'].reason, /copies differ/);
    assert.equal(by['gamma-skill'].what, 'Gamma fixture skill.');
    assert.ok(data.skills.every((s) => s.copies.every((c) => c.dir.startsWith('~'))), 'paths stay relative to HOME');
    assert.ok(!JSON.stringify(data).includes(home), 'the fixture home path is never in the payload');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

async function server(t, home) {
  const child = spawn(process.execPath, ['app/server.mjs', '0'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_ENV_FILE: path.join(home, 'env'),
      AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_PLANS: path.join(home, 'plans'),
      AGENTGLIM_DEV: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'exit'); fs.rmSync(home, { recursive: true, force: true }); });
  const port = await waitForServerReady(child);
  return `http://127.0.0.1:${port}`;
}

test('retire API and page are served by the AgentGlim server', async (t) => {
  const home = fixture();
  const base = await server(t, home);
  const page = await (await fetch(base + '/skills/retire')).text();
  assert.match(page, /<title>Skills to Retire · AgentGlim<\/title>/);
  assert.match(page, /\/api\/skills\/retire/);
  assert.match(page, /href="\/skills"/);
  assert.match(page, /id="themeToggle"/, 'the page carries the shared theme toggle');
  assert.doesNotMatch(page, new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const res = await fetch(base + '/api/skills/retire');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const body = await res.json();
  assert.ok(Array.isArray(body.skills));
  const by = Object.fromEntries(body.skills.map((s) => [s.id, s]));
  assert.ok(by['alpha-skill'] && by['beta-skill'] && by['gamma-skill'], 'lists the fixture skills');
  assert.equal(by['beta-skill'].uses, 4);
  assert.equal(by['alpha-skill'].copies.length, 2);
  assert.equal(typeof body.counts.keep, 'number');
  assert.ok(!JSON.stringify(body).includes(home), 'the API never returns the fixture home path');
  assert.equal((await fetch(base + '/api/skills/retire', { method: 'POST' })).status, 405);
});
