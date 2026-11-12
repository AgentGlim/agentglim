import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { loadIntegrations, skillsUrl } from '../integrations.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-integrations-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = path.join(home, 'data'), config = path.join(home, '.config/agentglim/integrations.json');
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  return { home, data, config, write, load: (env = {}) => loadIntegrations({ home, data, env }) };
}

test('absent, malformed, and non-object integrations disable optional readers', (t) => {
  const f = fixture(t), empty = f.load();
  assert.equal(empty.skillsUrl, '/skills');
  for (const key of ['auditPlan', 'remotePlan', 'fleetSnapshot', 'leadsPath', 'emailSequencePath', 'playwrightModule']) assert.equal(empty[key], null);
  for (const value of [null, [], 42]) { f.write(f.config, value); assert.deepEqual(f.load(), empty); }
  fs.writeFileSync(f.config, '{'); assert.deepEqual(f.load(), empty);
});

test('data file takes priority over XDG; explicit override is exclusive; paths expand safely', (t) => {
  const f = fixture(t);
  f.write(f.config, { leadsPath: '~/campaign', skillsUrl: 'http://localhost:9000/' });
  assert.equal(f.load().leadsPath, path.join(f.home, 'campaign'));
  f.write(path.join(f.data, 'integrations.json'), { auditPlan: '01-example-audit', remotePlan: '02-example-remote', emailSequencePath: '../mail', fleetSnapshot: './fleet.json', playwrightModule: '~/browser/node_modules/playwright' });
  const c = f.load();
  assert.equal(c.auditPlan, '01-example-audit'); assert.equal(c.remotePlan, '02-example-remote');
  assert.equal(c.emailSequencePath, path.join(f.home, 'mail')); assert.equal(c.fleetSnapshot, path.join(f.data, 'fleet.json'));
  assert.equal(c.playwrightModule, path.join(f.home, 'browser/node_modules/playwright'));
  assert.equal(c.leadsPath, null);
  assert.equal(f.load({ AGENTGLIM_INTEGRATIONS: path.join(f.home, 'missing.json') }).skillsUrl, '/skills');
  assert.equal(f.load({ AGENTGLIM_INTEGRATIONS: '~/.config/agentglim/integrations.json' }).skillsUrl, 'http://localhost:9000/');
  f.write(path.join(f.home, 'xdg/agentglim/integrations.json'), { skillsUrl: '/editor' });
  assert.equal(loadIntegrations({ home: f.home, data: path.join(f.home, 'empty'), env: { XDG_CONFIG_HOME: path.join(f.home, 'xdg') } }).skillsUrl, '/editor');
});

test('invalid fields cannot traverse the plans root or turn Skill Editor into a script link', (t) => {
  const f = fixture(t);
  f.write(f.config, { auditPlan: '../other', remotePlan: '/other', leadsPath: {}, skillsUrl: 'javascript:alert(1)' });
  assert.equal(f.load().auditPlan, null); assert.equal(f.load().remotePlan, null); assert.equal(f.load().leadsPath, null);
  for (const value of ['javascript:alert(1)', 'file:///tmp/editor', '//evil.example', '/\\evil.example', 'https://user:pass@example.com', null, 42]) assert.equal(skillsUrl(value), '/skills');
  assert.equal(skillsUrl('/skills?tab=local'), '/skills?tab=local');
  assert.equal(skillsUrl('http://127.0.0.1:9000/'), 'http://127.0.0.1:9000/');
});

// Exercise the real renderer against a small DOM double: a saved Setup card alone must not enable an integration.
test('custom panels require config, preserve saved order, and appear when enabled', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const render = html.slice(html.indexOf('function customPanel(s) {'), html.indexOf('\nfunction goalsTab(s)'));
  const card = {}, meta = {}, leads = {}, emailseq = {}, list = { children: [], appendChild(el) { this.children.push(el); }, querySelectorAll() { return []; } };
  const nodes = { customCard: card, cpList: list, cpMeta: meta };
  const context = vm.createContext({ $: (id) => nodes[id], document: { querySelector: (s) => s.includes('emailseq') ? emailseq : leads } });
  const setupCfg = { custom: [{ id: 'mail', kind: 'emailseq' }, { id: 'campaign', kind: 'leads' }] };
  vm.runInContext(render, context);
  context.s = { setupCfg, integrations: { leads: false, emailseq: false } };
  vm.runInContext('customPanel(s)', context);
  assert.equal(card.hidden, true); assert.equal(leads.hidden, true); assert.equal(emailseq.hidden, true);
  context.s.integrations = { leads: true, emailseq: true };
  vm.runInContext('customPanel(s)', context);
  assert.equal(card.hidden, false); assert.equal(leads.hidden, false); assert.equal(emailseq.hidden, false);
  assert.deepEqual(list.children, [emailseq, leads]);
  list.children = []; context.s.setupCfg = { custom: [] };
  vm.runInContext('customPanel(s)', context);
  assert.deepEqual(list.children, [leads, emailseq]);
});
