#!/usr/bin/env node
// worker-launch.mjs: start one worker agent on codex, claude, pi or opencode with a prompt file, and track it with the
// shipped jobs-track (tools/addons/jobs-track.py) so the dashboard's Agents table shows it while it runs.
//
//   node worker-launch.mjs <harness> <cwd> <promptfile> <outdir> <timeoutSeconds> <effort>
//        [--model M] [--plan NN-slug] [--label L] [--background] [--no-track] [--dry-run] [-- extra CLI args]
//   bash worker-launch.sh ...   (same arguments; the wrapper only finds node)
//
// harness   codex | claude | pi | opencode
// effort    passed as the CLI's own reasoning setting: codex -c model_reasoning_effort, claude --effort,
//           pi --thinking, opencode --variant. Use a level your CLI accepts (low, medium, high, ...).
// outdir    gets: pid (the worker CLI's pid), rc (exit code; 124 = timed out), last.txt (the worker's last message),
//           stdout.log, stderr.log and meta.json (harness, model, effort, paths, times, the command with the prompt
//           left out). Nothing from the environment is written: no keys, tokens or credentials are ever stored.
// --background  return at once (prints {"pid","outdir"}); the launcher keeps running detached and fills outdir.
// --no-track    skip jobs-track. Tracking needs Python 3 (python3, python or py). A missing Python or a failed jobs-track
//               never fails a launch, but it is reported: stderr warns, meta.json and the result carry `tracking: degraded`.
// --dry-run     print the command it would run (prompt left out) and exit.
//
// Sandboxing is the CLI's own. Codex runs `-s workspace-write` (change with --sandbox read-only|danger-full-access);
// Claude runs `--permission-mode acceptEdits` (change with --permission-mode). Pass anything else after `--`.
// Binaries: codex/claude/pi/opencode on PATH, or AGENTGLIM_<HARNESS>_BIN (tests point these at fixtures). On Windows an
// npm shim (codex.cmd, ...) runs through cmd.exe with the prompt on stdin or as a file reference, never on the
// command line (app/cli-spawn.mjs). A timeout kills the whole process tree (taskkill /T /F on Windows).
// Windows: run it as `node <run>/bin/worker-launch.mjs ...`, or the .sh form from Git Bash.
// jobs-track: AGENTGLIM_JOBS_TRACK (a jobs-track command), else jobs-track.py from this checkout via python3/python/py.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnCli, killTree } from '../../app/cli-spawn.mjs';

const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
export const HARNESSES = ['codex', 'claude', 'pi', 'opencode'];
const EFFORT_RE = /^[a-z]{2,10}$/;
const USAGE = 'usage: worker-launch <codex|claude|pi|opencode> <cwd> <promptfile> <outdir> <timeoutSeconds> <effort> [--model M] [--plan NN-slug] [--label L] [--background] [--no-track] [--dry-run] [-- extra args]';

export function parseArgs(argv) {
  const dash = argv.indexOf('--');
  const extra = dash >= 0 ? argv.slice(dash + 1) : [];
  const a = dash >= 0 ? argv.slice(0, dash) : argv.slice();
  const o = { extra, flags: new Set() }, pos = [];
  const VAL = ['--model', '--plan', '--label', '--sandbox', '--permission-mode'];
  for (let i = 0; i < a.length; i++) {
    if (VAL.includes(a[i])) { if (i + 1 >= a.length) throw new Error(`${a[i]} needs a value`); o[a[i].slice(2)] = a[++i]; }
    else if (/^--(background|no-track|dry-run|foreground)$/.test(a[i])) o.flags.add(a[i].slice(2));
    else if (a[i].startsWith('--')) throw new Error(`unknown option ${a[i]}`);
    else pos.push(a[i]);
  }
  if (pos.length !== 6) throw new Error(USAGE);
  const [harness, cwd, promptFile, outdir, timeout, effort] = pos;
  if (!HARNESSES.includes(harness)) throw new Error(`harness must be one of ${HARNESSES.join(', ')} (got ${harness})`);
  if (!/^\d+$/.test(timeout) || +timeout < 1) throw new Error('timeoutSeconds must be a whole number of seconds');
  if (!EFFORT_RE.test(effort)) throw new Error('effort must be a level such as low, medium, high or xhigh');
  if (o.plan && !/^\d\d-[a-z0-9][a-z0-9-]*$/.test(o.plan)) throw new Error('--plan must look like NN-slug');
  return { ...o, harness, cwd: path.resolve(cwd), promptFile: path.resolve(promptFile), outdir: path.resolve(outdir), timeout: +timeout, effort };
}

// The command for one harness. The prompt goes on stdin where the CLI reads it (codex, claude); pi and opencode get a
// closed stdin (both wait on an open one) and, after `--`, a short reference to the prompt file: no option parsing of
// the prompt, no argument size limit, and the prompt does not show in `ps`.
export function buildCommand(o, prompt, env = process.env) {
  const bin = env[`AGENTGLIM_${o.harness.toUpperCase()}_BIN`] || o.harness;
  const m = o.model ? ['--model', o.model] : [];
  if (o.harness === 'codex') return { bin, stdin: prompt, args: ['exec', '--skip-git-repo-check', '-C', o.cwd, '-s', o.sandbox || 'workspace-write', ...(o.model ? ['-m', o.model] : []), '-c', `model_reasoning_effort=${o.effort}`, '-o', path.join(o.outdir, 'last.txt'), ...o.extra, '-'], lastFromCli: true };
  if (o.harness === 'claude') return { bin, stdin: prompt, args: ['-p', '--output-format', 'text', '--effort', o.effort, '--permission-mode', o['permission-mode'] || 'acceptEdits', ...m, ...o.extra] };
  const ref = `Read the file ${o.promptFile} and do exactly what it says.`;
  if (ref.length > 8000) throw new Error('prompt file path is too long for a command-line argument');
  if (o.harness === 'pi') return { bin, stdin: null, args: ['-p', '--thinking', o.effort, ...m, ...o.extra, '--', ref], promptArg: true };
  return { bin, stdin: null, args: ['run', '--dir', o.cwd, '--variant', o.effort, ...m, ...o.extra, '--', ref], promptArg: true };
}
const shown = (c) => [c.bin, ...c.args];

// jobs-track command: an explicit one, else the shipped jobs-track.py through the first Python that starts
export function jobsTrackCmd(env = process.env) {
  if (env.AGENTGLIM_JOBS_TRACK === 'none') return null;
  if (env.AGENTGLIM_JOBS_TRACK) return [env.AGENTGLIM_JOBS_TRACK];
  let script = path.resolve(HERE, '..', '..', 'tools', 'addons', 'jobs-track.py');
  if (!fs.existsSync(script)) script = path.join(HERE, 'jobs-track.py');
  if (!fs.existsSync(script)) return null;
  for (const [py, pre] of [['python3', []], ['python', []], ['py', ['-3']]]) {
    try { if (spawnSync(py, [...pre, '--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true }).status === 0) return [py, ...pre, script]; } catch {}
  }
  return null;
}
// Runs jobs-track without blocking: the worker is already running while this records it, so a slow tracker
// (Windows process lookups) delays only the dashboard entry, never the worker. Resolves to { id, error }.
export function track(cmd, args, env = process.env, timeoutMs = 60000) {
  if (!cmd) return Promise.resolve({ id: '', error: 'no jobs-track command' });
  return new Promise((resolve) => {
    let out = '', errText = '', done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    let p;
    try { p = spawn(cmd[0], [...cmd.slice(1), ...args], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ id: '', error: `jobs-track could not start (${cmd[0]}): ${e.message || e}` }); }
    const timer = setTimeout(() => { try { p.kill(); } catch {} finish({ id: '', error: `jobs-track took longer than ${Math.round(timeoutMs / 1000)} s` }); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { errText += d; });
    p.on('error', (e) => finish({ id: '', error: e.code === 'ENOENT' ? `jobs-track command not found: ${cmd[0]}` : `jobs-track could not start: ${e.message}` }));
    p.on('close', (code) => finish(code === 0 && out.trim() ? { id: out.trim().split('\n').pop().trim(), error: '' }
      : { id: '', error: `jobs-track start failed (exit ${code})${errText.trim() ? ': ' + errText.trim().split('\n').pop().slice(0, 200) : ''}` }));
  });
}

const write = (f, t) => { try { fs.writeFileSync(f, t); } catch {} };

export async function launch(o, env = process.env) {
  const prompt = fs.readFileSync(o.promptFile, 'utf8');
  if (!prompt.trim()) throw new Error(`prompt file is empty: ${o.promptFile}`);
  if (!fs.statSync(o.cwd).isDirectory()) throw new Error(`cwd is not a folder: ${o.cwd}`);
  const c = buildCommand(o, prompt, env);
  if (o.flags.has('dry-run')) return { dryRun: true, cwd: o.cwd, cmd: shown(c) };
  fs.mkdirSync(o.outdir, { recursive: true });
  for (const n of ['rc', 'pid', 'last.txt']) { try { fs.renameSync(path.join(o.outdir, n), path.join(o.outdir, `${n}.prev`)); } catch {} }
  const started = Date.now();
  const meta = { harness: o.harness, model: o.model || null, effort: o.effort, cwd: o.cwd, promptFile: o.promptFile, outdir: o.outdir,
    timeoutSeconds: o.timeout, plan: o.plan || null, label: o.label || null, started: new Date(started).toISOString(), cmd: shown(c), launcher: 'worker-launch' };
  write(path.join(o.outdir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  const out = fs.openSync(path.join(o.outdir, 'stdout.log'), 'w'), err = fs.openSync(path.join(o.outdir, 'stderr.log'), 'w');
  let child;
  try { child = spawnCli(c.bin, c.args, { cwd: o.cwd, env, stdio: [c.stdin == null ? 'ignore' : 'pipe', out, err] }, { env }); }
  catch (e) { child = null; meta.error = String(e.message || e); }
  const result = await new Promise((resolve) => {
    if (!child) return resolve({ rc: 127, error: meta.error });
    let timedOut = false, done = false, killer = null;
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ rc: 127, error: e.code === 'ENOENT' ? `${c.bin} is not installed or not on PATH` : String(e.message) }); } });
    if (child.pid) write(path.join(o.outdir, 'pid'), `${child.pid}\n`);
    const tj = o.flags.has('no-track') ? null : jobsTrackCmd(env);
    const id = `wl-${crypto.createHash('sha1').update(`${o.outdir}|${child.pid}|${started}`).digest('hex').slice(0, 12)}`;
    // Tracking runs alongside the worker (async), so it can never hold up the launch. No pid means the CLI
    // itself did not start: that error is reported above (rc 127), not as a tracking failure.
    const trackP = !child.pid || o.flags.has('no-track') ? Promise.resolve(null)
      : !tj ? Promise.resolve({ id: '', error: env.AGENTGLIM_JOBS_TRACK === 'none' ? 'AGENTGLIM_JOBS_TRACK=none' : 'no Python 3 (python3, python or py) or no jobs-track.py found' })
      : track(tj, ['start', '--harness', o.harness, '--id', id, '--pid', String(child.pid), '--cwd', o.cwd, '--outdir', o.outdir, '--prompt-file', o.promptFile,
        '--launcher', 'worker-launch', ...(o.model ? ['--model', o.model] : []), ...(o.label ? ['--label', o.label] : []), ...(o.plan ? ['--plan', o.plan] : [])], env);
    const tracking = trackP.then((t) => {
      if (!t) return '';
      if (t.id) { meta.jobId = t.id; return t.id; }
      meta.tracking = `degraded: ${t.error}; this worker will not show in the dashboard`;
      if (env.AGENTGLIM_JOBS_TRACK !== 'none') process.stderr.write(`worker-launch: tracking ${meta.tracking}\n`);
      return '';
    });
    // timeout: kill the whole tree (process group on POSIX, taskkill /T /F on Windows); close fires once it is gone
    const timer = setTimeout(() => { timedOut = true; killTree(child, { graceMs: 10e3 }); }, o.timeout * 1000);
    if (c.stdin != null) { child.stdin.on('error', () => {}); child.stdin.end(c.stdin); }
    child.on('close', (code, signal) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(killer);
      const rc = timedOut ? 124 : code ?? (signal ? 128 + ({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2 }[signal] || 1) : 1);
      tracking.then(async (tracked) => { if (tracked) await track(tj, ['finish', '--id', tracked, '--rc', String(rc)], env); resolve({ rc, timedOut }); });
    });
  });
  fs.closeSync(out); fs.closeSync(err);
  const lastF = path.join(o.outdir, 'last.txt');
  if (!c.lastFromCli || !fs.existsSync(lastF)) {
    let text = ''; try { text = fs.readFileSync(path.join(o.outdir, 'stdout.log'), 'utf8'); } catch {}
    if (!text.trim() && result.error) text = result.error;
    write(lastF, text.length > 20000 ? text.slice(-20000) : text);
  }
  Object.assign(meta, { ended: new Date().toISOString(), rc: result.rc, timedOut: !!result.timedOut, ...(result.error ? { error: result.error } : {}) });
  write(path.join(o.outdir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  write(path.join(o.outdir, 'rc'), `${result.rc}\n`); // written last: its presence means the job is over
  return { rc: result.rc, outdir: o.outdir, jobId: meta.jobId || null, ...(meta.tracking ? { tracking: meta.tracking } : {}), timedOut: !!result.timedOut, error: result.error || null };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); if (!fs.existsSync(o.promptFile)) throw new Error(`prompt file not found: ${o.promptFile}`); }
  catch (e) { console.error(`worker-launch: ${e.message}`); process.exit(2); }
  if (o.flags.has('background') && !o.flags.has('foreground') && !o.flags.has('dry-run')) {
    fs.mkdirSync(o.outdir, { recursive: true });
    const argv = process.argv.slice(2).filter((x) => x !== '--background');
    const dash = argv.indexOf('--'); argv.splice(dash >= 0 ? dash : argv.length, 0, '--foreground');
    const log = fs.openSync(path.join(o.outdir, 'launcher.log'), 'a');
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv], { detached: true, stdio: ['ignore', log, log], windowsHide: true });
    c.unref();
    console.log(JSON.stringify({ background: true, launcherPid: c.pid, outdir: o.outdir }));
    process.exit(0);
  }
  try {
    const r = await launch(o);
    console.log(JSON.stringify(r));
    process.exitCode = r.dryRun ? 0 : r.rc;
  } catch (e) { console.error(`worker-launch: ${e.message}`); process.exitCode = 2; }
}
