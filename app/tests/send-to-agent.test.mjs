// Send to agent: per-adapter tests on fixture sessions in temp dirs only (never ~/.agentglim, the live
// dashboard or real sessions). Each proves the agent gets the exact text once, retries do not duplicate it,
// and a dead session falls back to Copy with the reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendToAgent, sendStatus, sendConfig, pickAdapter, runHook } from '../send-to-agent.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-send-'));
const TEXT = '# Approvals\n\n- [01] Decision D1: pick a model\n  choice: Accept default\n  id: x1\n';
function fakeRunner(script) { // script: array of {code, out}; records calls
  const calls = [];
  const run = async (cmd, args, input) => { calls.push({ cmd, args, input }); return script[Math.min(calls.length - 1, script.length - 1)]; };
  return { run, calls };
}
function base(extra = {}) {
  const home = tmp();
  return { home, cfg: sendConfig({ HOME: home }, { data: path.join(home, 'data'), inbox: path.join(home, 'run', 'chat_inbox'), claudeHome: path.join(home, '.claude'), codexHome: path.join(home, '.codex'), ...extra }) };
}

test('pickAdapter maps sources and falls back to copy', () => {
  assert.equal(pickAdapter({ kind: 'plans' }), 'plans');
  assert.equal(pickAdapter({ kind: 'claude', session: 'abc123-def' }), 'claude');
  assert.equal(pickAdapter({ kind: 'codex', session: 'abc123-def' }), 'codex');
  assert.equal(pickAdapter({ kind: 'claude' }), 'copy');
  assert.equal(pickAdapter({ kind: 'cursor', session: 'abc123' }), 'copy');
  assert.equal(pickAdapter(null), 'copy');
});

test('plans harness: one inbox file with the exact text, no duplicate on a second send, read after answered', async () => {
  const { cfg } = base(); fs.mkdirSync(cfg.inbox, { recursive: true });
  const r1 = await sendToAgent({ text: TEXT, source: { kind: 'plans' } }, cfg);
  assert.equal(r1.state, 'delivered');
  const r2 = await sendToAgent({ text: TEXT, source: { kind: 'plans' } }, cfg);
  assert.equal(r2.id, r1.id); assert.equal(r2.state, 'delivered');
  const files = fs.readdirSync(cfg.inbox).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const msg = JSON.parse(fs.readFileSync(path.join(cfg.inbox, files[0]), 'utf8'));
  assert.equal(msg.text, TEXT);
  // the waiter answers it (chat-write.mjs renames to .answered)
  fs.renameSync(path.join(cfg.inbox, files[0]), path.join(cfg.inbox, files[0] + '.answered'));
  assert.equal(sendStatus(r1.id, null, cfg).state, 'read');
});

test('plans harness: no inbox fails twice, then Copy with the reason', async () => {
  const { cfg } = base();
  const r = await sendToAgent({ text: TEXT, source: { kind: 'plans' } }, cfg);
  assert.equal(r.state, 'failed'); assert.equal(r.fallback, 'copy'); assert.equal(r.attempts, 2);
  assert.match(r.reason, /no harness inbox/);
});

test('claude running: session inbox once, hook hands it over once and marks read', async () => {
  const { cfg } = base({ claudeState: () => 'running' });
  const source = { kind: 'claude', session: 'sess-fixture-1' };
  const r1 = await sendToAgent({ text: TEXT, source }, cfg);
  await sendToAgent({ text: TEXT, source }, cfg);
  assert.equal(r1.state, 'delivered');
  const box = fs.readFileSync(path.join(cfg.data, 'session-inbox', 'sess-fixture-1.ndjson'), 'utf8').trim().split('\n');
  assert.equal(box.length, 1);
  const out = JSON.parse(runHook(JSON.stringify({ session_id: 'sess-fixture-1', hook_event_name: 'UserPromptSubmit' }), cfg));
  assert.equal(out.hookSpecificOutput.additionalContext.split(TEXT).length - 1, 1);
  assert.equal(runHook(JSON.stringify({ session_id: 'sess-fixture-1', hook_event_name: 'Stop' }), cfg), '');
  assert.equal(sendStatus(r1.id, null, cfg).state, 'read');
});

test('claude Stop hook blocks with the text so the session carries on', async () => {
  const { cfg } = base({ claudeState: () => 'running' });
  await sendToAgent({ text: TEXT, source: { kind: 'claude', session: 'sess-fixture-2' } }, cfg);
  const out = JSON.parse(runHook(JSON.stringify({ session_id: 'sess-fixture-2', hook_event_name: 'Stop' }), cfg));
  assert.equal(out.decision, 'block'); assert.ok(out.reason.includes(TEXT));
});

test('claude idle: claude --resume -p once; a failed first try retries without duplicating', async () => {
  const fr = fakeRunner([{ code: 1, out: 'busy' }, { code: 0, out: 'ok' }]);
  const { cfg } = base({ claudeState: () => 'idle', runner: fr.run });
  const source = { kind: 'claude', session: 'sess-fixture-3' };
  const r = await sendToAgent({ text: TEXT, source }, cfg);
  assert.equal(r.state, 'read'); assert.equal(r.attempts, 2);
  await sendToAgent({ text: TEXT, source }, cfg);
  assert.equal(fr.calls.length, 2);
  assert.deepEqual(fr.calls[1].args.slice(0, 2), ['--resume', 'sess-fixture-3']); assert.equal(fr.calls[1].args.at(-1), '-p'); assert.equal(fr.calls[1].input, TEXT, 'text on stdin, never an argument');
});

test('claude dead session falls back to Copy with the reason', async () => {
  const fr = fakeRunner([{ code: 0, out: '' }]);
  const { cfg } = base({ runner: fr.run }); // default state check: no transcript in the temp claude home
  const r = await sendToAgent({ text: TEXT, source: { kind: 'claude', session: 'sess-missing' } }, cfg);
  assert.equal(r.state, 'failed'); assert.equal(r.fallback, 'copy'); assert.match(r.reason, /session not found/);
  assert.equal(fr.calls.length, 0);
});

test('codex: codex exec resume with the text on stdin, exactly once', async () => {
  const fr = fakeRunner([{ code: 0, out: 'done' }]);
  const { home, cfg } = base({ runner: fr.run });
  const d = path.join(home, '.codex', 'sessions', '2026', '11', '13'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'rollout-2026-11-13T00-00-00-cdx-fixture-1.jsonl'), '{}\n');
  const cfg2 = sendConfig({ HOME: home }, { data: cfg.data, codexHome: path.join(home, '.codex'), runner: fr.run });
  const source = { kind: 'codex', session: 'cdx-fixture-1' };
  const r = await sendToAgent({ text: TEXT, source }, cfg2);
  await sendToAgent({ text: TEXT, source }, cfg2);
  assert.equal(r.state, 'read');
  assert.equal(fr.calls.length, 1);
  assert.deepEqual(fr.calls[0].args.slice(-3), ['resume', 'cdx-fixture-1', '-']); assert.ok(fr.calls[0].args.includes('workspace-write'), 'resumed turn can write');
  assert.equal(fr.calls[0].input, TEXT);
});

test('codex: failing twice falls back to Copy with the reason', async () => {
  const fr = fakeRunner([{ code: 2, out: 'session expired' }]);
  const { cfg } = base({ runner: fr.run, codexState: () => true });
  const r = await sendToAgent({ text: TEXT, source: { kind: 'codex', session: 'cdx-fixture-2' } }, cfg);
  assert.equal(r.state, 'failed'); assert.equal(r.fallback, 'copy'); assert.equal(fr.calls.length, 2);
  assert.match(r.reason, /session expired/);
});

test('unknown agents get Copy', async () => {
  const { cfg } = base();
  const r = await sendToAgent({ text: TEXT, source: { kind: 'cursor' } }, cfg);
  assert.equal(r.state, 'copy'); assert.equal(r.fallback, 'copy');
});

import { execFileSync } from 'node:child_process';
import { addClaudeHooks, removeClaudeHooks, hookCommand } from '../send-to-agent-install.mjs';
const CLI = fileURLToPath(new URL('../send-to-agent.mjs', import.meta.url));

test('install-hooks: Claude settings get both hooks once, keep other hooks, back up, uninstall removes only ours', () => {
  const home = tmp(); const f = path.join(home, '.claude', 'settings.json'); fs.mkdirSync(path.dirname(f), { recursive: true });
  const orig = { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } };
  fs.writeFileSync(f, JSON.stringify(orig));
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '', AGENTGLIM_CODEX_BIN: path.join(home, 'no-codex') };
  const run = (...a) => execFileSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8' });
  assert.match(run('install-hooks', '--claude', '--dry-run'), /would update/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), orig);
  assert.match(run('install-hooks', '--claude'), /updated .*backup/);
  assert.match(run('install-hooks', '--claude'), /already up to date/);
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(s.hooks.UserPromptSubmit.length, 1); assert.equal(s.hooks.Stop.length, 2);
  assert.equal(s.hooks.Stop[1].hooks[0].command, hookCommand());
  assert.equal(fs.readdirSync(path.dirname(f)).filter((n) => n.includes('.bak-agentglim-')).length, 1);
  run('uninstall-hooks', '--claude');
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), orig);
  assert.match(run('uninstall-hooks', '--claude'), /already up to date/);
});

test('install-hooks: pure add/remove are inverse and Codex without a binary says Copy', () => {
  const { settings } = addClaudeHooks({});
  assert.deepEqual(removeClaudeHooks(settings).settings, {});
  assert.equal(addClaudeHooks(settings).changed, false);
  const home = tmp();
  const out = (() => { try { return execFileSync(process.execPath, [CLI, 'install-hooks', '--codex'], { env: { ...process.env, HOME: home, USERPROFILE: home, AGENTGLIM_CODEX_BIN: path.join(home, 'none') }, encoding: 'utf8' }); } catch (e) { return `${e.stdout}${e.stderr}`; } })();
  assert.match(out, /not installed.*Copy/);
});
