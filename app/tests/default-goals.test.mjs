import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = path.resolve(import.meta.dirname, '../..');
const defaults = name => fs.readFileSync(path.join(root, 'app/defaults/goals', name), 'utf8');

async function start(t, home, overrides = {}) {
  const port = 19364;
  const child = spawn(process.execPath, ['app/server.mjs', String(port)], {
    cwd: root,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, USERPROFILE: home,
      AGENTGLIM_ENV_FILE: path.join(home, 'env'), AGENTGLIM_DEV: '1', ...overrides },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, 'exit');
    }
  });
  for (let i = 0; i < 100 && child.exitCode === null; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/setup`);
      if (response.ok) {
        assert.doesNotMatch(errors, /goals (?:sync|review) failed/);
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`server failed to start: ${errors}`);
}

test('startup seeds default goals and preserves existing private files', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-default-goals-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, 'env'), '');
  const data = path.join(home, '.agentglim');
  const goals = path.join(data, 'goals');

  await t.test('fresh HOME gets both defaults and a synced context', async t => {
    assert.equal(fs.existsSync(goals), false);
    await start(t, home);
    for (const name of ['goals.json', 'goal-map.json']) {
      assert.equal(fs.readFileSync(path.join(goals, name), 'utf8'), defaults(name));
    }
    const context = JSON.parse(fs.readFileSync(path.join(data, 'goals-context.json'), 'utf8'));
    assert.deepEqual(context.goals.map(g => g.id), ['ship', 'learn']);
  });

  await t.test('restart preserves both existing files byte for byte', async t => {
    const existingGoals = JSON.stringify({ goals: [{ id: 'custom', title: 'Custom goal' }] }) + '\n';
    const existingMap = '{ "plans": {}, "labels": { "custom": "Custom" } }\n';
    fs.writeFileSync(path.join(goals, 'goals.json'), existingGoals);
    fs.writeFileSync(path.join(goals, 'goal-map.json'), existingMap);
    await start(t, home);
    assert.equal(fs.readFileSync(path.join(goals, 'goals.json'), 'utf8'), existingGoals);
    assert.equal(fs.readFileSync(path.join(goals, 'goal-map.json'), 'utf8'), existingMap);
    const context = JSON.parse(fs.readFileSync(path.join(data, 'goals-context.json'), 'utf8'));
    assert.deepEqual(context.goals.map(g => g.id), ['custom']);
  });

  await t.test('configured private paths receive defaults without replacing an existing map', async t => {
    const privateData = path.join(home, 'private');
    const privateGoals = path.join(home, 'configured-goals');
    fs.mkdirSync(privateGoals);
    fs.writeFileSync(path.join(privateGoals, 'goal-map.json'), '{}\n');
    await start(t, home, { AGENTGLIM_DATA: privateData, AGENTGLIM_GOALS: privateGoals });
    assert.equal(fs.readFileSync(path.join(privateGoals, 'goals.json'), 'utf8'), defaults('goals.json'));
    assert.equal(fs.readFileSync(path.join(privateGoals, 'goal-map.json'), 'utf8'), '{}\n');
    assert.ok(fs.existsSync(path.join(privateData, 'goals-context.json')));
  });
});
