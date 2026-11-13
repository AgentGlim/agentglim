import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { waitForServerReady } from './helpers/server-ready.mjs';

// Regression test for GitHub issue #1: "Open full goals page" showed
//   goals.html not built yet: node scripts/build_goals_page.mjs in your goals folder
// on a fresh install even though the repo ships a live goals page. /goals-page must
// serve that bundled page (the app/goals-app.html sub-app) when the goals folder has
// no pre-built goals.html.
async function start(t, goalsDir) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-goals-page-'));
  fs.writeFileSync(path.join(home, 'env'), '');
  fs.mkdirSync(goalsDir, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: home,
    USERPROFILE: home,
    AGENTGLIM_ENV_FILE: path.join(home, 'env'),
    AGENTGLIM_DATA: path.join(home, '.agentglim'),
    AGENTGLIM_GOALS: goalsDir,
    AGENTGLIM_DEV: '1',
  };
  const srv = spawn(process.execPath, ['app/server.mjs', '0'], {
    cwd: path.resolve(import.meta.dirname, '../..'), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { srv.kill(); if (srv.exitCode === null) await once(srv, 'exit'); });
  const port = await waitForServerReady(srv);
  return `http://127.0.0.1:${port}`;
}

test('goals-page serves the bundled live page when the goals folder has no built page', async t => {
  const goalsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-goals-empty-'));
  t.after(() => fs.rmSync(goalsDir, { recursive: true, force: true }));
  const base = await start(t, goalsDir);
  const res = await fetch(base + '/goals-page');
  const body = await res.text();
  assert.equal(res.status, 200, body);
  assert.doesNotMatch(body, /not built yet/);
  assert.match(body, /<title>Goals<\/title>/);
  assert.match(body, /src="\/goals-app\.mjs"/);
});

test('goals-page prefers a goals folder page built by build_goals_page.mjs', async t => {
  const goalsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-goals-built-'));
  t.after(() => fs.rmSync(goalsDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(goalsDir, 'goals.html'), '<!doctype html><title>built goals sentinel</title>');
  const base = await start(t, goalsDir);
  const res = await fetch(base + '/goals-page');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /built goals sentinel/);
});
