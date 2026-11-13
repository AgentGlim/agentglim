// End-to-end proof for Send to agent with the real CLIs (costs a few cheap model calls; not part of npm test).
//   node app/tests/send-to-agent.e2e.mjs OUT_DIR
// AgentGlim data, the Claude settings file (with the hooks put there by install-hooks) and the working folder are
// all temp. The CLIs use their normal login, so each run leaves one new throwaway session per CLI; no existing
// session or settings file is touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sendToAgent, sendStatus, sendConfig, runProcess } from '../send-to-agent.mjs';

const OUT = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'ag-e2e-out-')));
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-e2e-'));
const data = path.join(T, 'data'), cwd = path.join(T, 'work'), settings = path.join(T, 'claude-settings.json');
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
const CLI = new URL('../send-to-agent.mjs', import.meta.url).pathname;
const env = { ...process.env, AGENTGLIM_DATA: data };
const log = [];
const note = (k, v) => { log.push({ k, v }); console.log(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`); };
const recRun = (label) => async (cmd, args, input) => {
  const r = await new Promise((res) => { const p = runProcess(cmd, args, input, 300e3); p.then(res); });
  fs.writeFileSync(path.join(OUT, `${label}.txt`), `$ ${cmd} ${args.map((a) => a.length > 60 ? JSON.stringify(a.slice(0, 60) + '...') : a).join(' ')}\n${input ? `[stdin] ${input}\n` : ''}--- exit ${r.code}\n${r.out}`);
  return r;
};
const sh = (cmd, args, label, input) => { const r = execFileSync(cmd, args, { cwd, env, encoding: 'utf8', input: input || '', stdio: ['pipe', 'pipe', 'pipe'], timeout: 300e3 }); fs.writeFileSync(path.join(OUT, `${label}.txt`), `$ ${cmd} ${args.join(' ')}\n--- \n${r}`); return r; };
process.chdir(cwd);

// ---------- Claude Code ----------
note('install', execFileSync(process.execPath, [CLI, 'install-hooks', '--claude', '--settings', settings], { env, encoding: 'utf8' }).trim());
const CM = ['--model', 'haiku', '--settings', settings];
const start = JSON.parse(sh('claude', ['-p', ...CM, '--output-format', 'json', 'Reply with exactly: READY'], 'claude-1-start'));
const cs = start.session_id; note('claude session', cs);
// idle session -> claude --resume <id> -p TEXT
const codeA = 'BLUE-' + Math.random().toString(36).slice(2, 6).toUpperCase();
const cfgIdle = sendConfig(env, { data, claudeArgs: CM, runner: recRun('claude-2-send-idle-resume') });
const rA = await sendToAgent({ text: `The owner answered from AgentGlim Approvals: choice ${codeA}. Reply with exactly: GOT ${codeA}`, source: { kind: 'claude', session: cs } }, cfgIdle);
note('claude idle send', rA);
const outA = fs.readFileSync(path.join(OUT, 'claude-2-send-idle-resume.txt'), 'utf8');
note('claude idle reply has code', outA.includes(`GOT ${codeA}`));
const rA2 = await sendToAgent({ text: `The owner answered from AgentGlim Approvals: choice ${codeA}. Reply with exactly: GOT ${codeA}`, source: { kind: 'claude', session: cs } }, cfgIdle);
note('claude idle second click (no resend)', { state: rA2.state, resumedLines: fs.readFileSync(path.join(data, 'session-inbox', `${cs}.resumed`), 'utf8').trim().split('\n').length });
// running session -> session inbox + UserPromptSubmit hook
const codeB = 'GREEN-' + Math.random().toString(36).slice(2, 6).toUpperCase();
const cfgRun = sendConfig(env, { data, claudeState: async () => 'running' });
const rB = await sendToAgent({ text: `Use plan ${codeB}.`, source: { kind: 'claude', session: cs } }, cfgRun);
note('claude running send (inbox)', rB);
const turn = JSON.parse(sh('claude', ['--resume', cs, '-p', ...CM, '--output-format', 'json', 'Which plan code did the owner just send from AgentGlim? Reply with only the code.'], 'claude-3-hook-turn'));
note('claude hook reply', turn.result);
note('claude hook reply has code', String(turn.result).includes(codeB));
note('claude status after hook', sendStatus(rB.id, { kind: 'claude', session: cs }, cfgRun).state);

// ---------- Codex ----------
note('codex check', execFileSync(process.execPath, [CLI, 'install-hooks', '--codex'], { env, encoding: 'utf8' }).trim());
const XM = ['--skip-git-repo-check', '-m', process.env.E2E_CODEX_MODEL || 'gpt-6-astra', '-c', 'model_reasoning_effort="low"'];
const cx = await runProcess('codex', ['exec', ...XM, 'Reply with exactly: READY'], '', 300e3); // session id is on stderr
const cxOut = cx.out, xs = (/session id: ([0-9a-f-]{36})/.exec(cxOut) || [])[1];
fs.writeFileSync(path.join(OUT, 'codex-1-start.txt'), `$ codex exec ${XM.join(' ')} "Reply with exactly: READY"\n---\n${cxOut}`);
note('codex session', xs);
const codeC = 'RED-' + Math.random().toString(36).slice(2, 6).toUpperCase();
const cfgX = sendConfig(env, { data, codexArgs: XM, runner: recRun('codex-2-send-exec-resume') });
const rC = await sendToAgent({ text: `The owner answered from AgentGlim Approvals: choice ${codeC}. Reply with exactly: GOT ${codeC}`, source: { kind: 'codex', session: xs } }, cfgX);
note('codex send', rC);
note('codex reply has code', fs.readFileSync(path.join(OUT, 'codex-2-send-exec-resume.txt'), 'utf8').includes(`GOT ${codeC}`));
const rC2 = await sendToAgent({ text: `The owner answered from AgentGlim Approvals: choice ${codeC}. Reply with exactly: GOT ${codeC}`, source: { kind: 'codex', session: xs } }, cfgX);
note('codex second click (no resend)', rC2.state);
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(log, null, 2));
const pass = log.filter((l) => /has code/.test(l.k)).every((l) => l.v === true);
console.log(pass ? 'E2E PASS' : 'E2E FAIL'); process.exitCode = pass ? 0 : 1;
