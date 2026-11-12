import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function server(t, skillsUrl = 'http://127.0.0.1:9000/?tab=all&view=edit') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-integration-server-'));
  const write = (file, content) => { const f = path.join(home, file); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content)); };
  write('env', ''); write('harness.json', '{}');
  write('data/setup.json', { custom: [{ id: 'mail', kind: 'emailseq' }, { id: 'campaign', kind: 'leads' }] });
  write('data/integrations.json', { auditPlan: '01-example-audit', remotePlan: '02-example-remote', leadsPath: '~/campaign', emailSequencePath: '~/mail', fleetSnapshot: '~/fleet.json', skillsUrl });
  write('campaign/.artifacts/campaign/day/run/campaign.json', { name: 'Example campaign', chunks: [{ n: 1, run: 'chunk', status: 'done', rows: 10, qualified: 6, spend_total_usd: 2 }] });
  write('campaign/model_prices.json', { updated_at: '2026-01-01', models: {} });
  write('mail/state/pushed.csv', 'pushed_at,email,campaign_id\n2026-01-01,contact@example.com,example\n');
  write('mail/state/replies.csv', 'marked_at,email,outcome,note\n2026-01-02,contact@example.com,yes,\n');
  write('plans/01-example-audit/PLAN.md', '# Example audit\n');
  write('plans/01-example-audit/_build/subitems.json', { items: [{ id: 'feature', title: 'Example feature', kind: 'feature', status: 'done', pct: 100 }] });
  write('plans/02-example-remote/PLAN.md', '# Example remote\n');
  write('plans/02-example-remote/_build/subitems.json', { items: [{ id: 'one', status: 'done', brief: '_build/features/one/BRIEF.md' }] });
  write('plans/02-example-remote/_build/features/one/r1/AUDIT.md', '## Progress\nOverall spec completion: 93%.\n');
  write('plans/_run/state.json', { projects: { '01-example-audit': { stage: 'done', stages: [] }, '02-example-remote': { stage: 'done', stages: [] } } });
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise((r) => socket.close(r));
  const child = spawn(process.execPath, ['app/server.mjs', String(port)], { cwd: path.resolve(import.meta.dirname, '../..'), env: {
    PATH: process.env.PATH, HOME: home, AGENTGLIM_DATA: path.join(home, 'data'), AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_CONFIG: path.join(home, 'harness.json'), AGENTGLIM_PROJECTS: home, AGENTGLIM_PLANS: path.join(home, 'plans'), AGENTGLIM_DEV: '1',
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', (s) => { errors += s; });
  t.after(async () => { child.kill(); if (child.exitCode === null) await once(child, 'exit'); fs.rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/setup')).ok) return { base, home }; } catch {}
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`isolated server failed to start: ${errors}`);
}

test('private integrations drive campaign, email, feature plans, fleet, and the Skills link', async (t) => {
  const { base, home } = await server(t);
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /id="skillsLink" href="http:\/\/127\.0\.0\.1:9000\/\?tab=all&amp;view=edit"/);
  assert.equal((await fetch(base + '/skills')).status, 200);
  const s = await (await fetch(base + '/api/snapshot')).json();
  assert.deepEqual(s.integrations, { leads: true, emailseq: true });
  assert.equal(s.leads.name, 'Example campaign'); assert.equal(s.leads.qualified, 6); assert.equal(s.leads.usd, 2);
  assert.equal(s.emailSeq.pushed, 1); assert.equal(s.emailSeq.outcomes.yes, 1);
  assert.equal(s.fleet.state, 'not_set_up'); assert.equal(s.fleet.path, path.join(home, 'fleet.json'));
  assert.equal(s.prices.ledgerUpdated, '2026-01-01');
  assert.deepEqual(s.setupCfg.custom.map((c) => c.kind), ['emailseq', 'leads']);
  const audit = s.statusDigest.plans.find((p) => p.dir === '01-example-audit');
  assert.equal(audit.features.items[0].title, 'Example feature');
  assert.equal(s.projects.find((p) => p.dir === '02-example-remote').progress.pct, 93);
});

test('unsafe Skills URLs fall back to the built-in page in the actual HTML response', async (t) => {
  const { base } = await server(t, 'javascript:alert(1)');
  assert.match(await (await fetch(base + '/')).text(), /id="skillsLink" href="\/skills"/);
});
