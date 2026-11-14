// cli-spawn.mjs: start an agent CLI the same way on every OS, and stop it with its whole process tree.
// No dependencies beyond node: harness/bin/worker-launch.mjs and app/send-to-agent.mjs both import it.
//
// findBinary  PATH (+ PATHEXT on Windows) lookup; app/deps.mjs re-exports this one resolver.
// cliCommand  the real command for a bin name: on Windows an npm shim (codex.cmd, pi.cmd, ...) runs through
//             `cmd.exe /d /s /c "<shim> args"`. The prompt never goes on that command line: callers pass it on stdin
//             or as a file reference, and arguments cmd.exe would expand (%, ", newlines) are refused.
// spawnCli    spawn with that command; on POSIX the child leads its own process group.
// killTree    kill the child and every descendant (taskkill /T /F on Windows, the process group on POSIX) and
//             resolve only once the child has exited, so a caller never retries while the old run is alive.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const isExec = (f) => { try { return fs.statSync(f).isFile() && (fs.accessSync(f, fs.constants.X_OK), true); } catch { return false; } };
export function findBinary(bin, { env = process.env, home = os.homedir(), platform = process.platform, exists = isExec } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (paths.isAbsolute(bin) || /[\\/]/.test(bin)) {
    const exts = platform === 'win32' && !paths.extname(bin) ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
    for (const e of exts) if (exists(bin + e)) return bin + e;
    return null;
  }
  const dirs = [...(env.PATH || env.Path || '').split(paths.delimiter), ...['.local/bin', '.npm-global/bin', '.bun/bin', '.opencode/bin', '.cargo/bin'].map((d) => paths.join(home, d)), '/usr/local/bin', '/opt/homebrew/bin'];
  const suffixes = platform === 'win32' ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  for (const dir of dirs.filter(Boolean)) for (const suffix of suffixes) { const f = paths.join(dir.replace(/^"(.*)"$/, '$1'), bin + suffix); if (exists(f)) return f; }
  return null;
}

// cmd.exe expands %VAR% even inside quotes and ends the line at a newline; quotes would break the quoting itself
const CMD_UNSAFE = /[%"\r\n\0]/;
export function cliCommand(bin, args, { env = process.env, platform = process.platform, resolve = findBinary } = {}) {
  if (platform !== 'win32') return { cmd: bin, args, shim: false };
  const found = resolve(bin, { env, platform }) || bin;
  if (!/\.(cmd|bat)$/i.test(found)) return { cmd: found, args, shim: false };
  const bad = [found, ...args].find((a) => CMD_UNSAFE.test(String(a)));
  if (bad != null) throw new Error(`cannot pass ${JSON.stringify(String(bad).slice(0, 40))} to the ${path.basename(found)} shim safely (no %, " or newlines); put it in a file instead`);
  const line = [found, ...args].map((a) => `"${a}"`).join(' ');
  return { cmd: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], shim: true, verbatim: true };
}

export function spawnCli(bin, args, opts = {}, { env = opts.env || process.env, platform = process.platform } = {}) {
  const c = cliCommand(bin, args, { env, platform });
  return spawn(c.cmd, c.args, { windowsHide: true, ...opts, detached: platform !== 'win32', ...(c.verbatim ? { windowsVerbatimArguments: true } : {}) });
}

export function killTree(child, { graceMs = 5000, platform = process.platform } = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
  const exited = new Promise((res) => child.once('close', res));
  const hard = () => {
    if (platform === 'win32') { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }); } catch {} try { child.kill('SIGKILL'); } catch {} }
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }
  };
  if (platform === 'win32') hard();
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} } }
  const t = setTimeout(hard, graceMs);
  return exited.finally(() => clearTimeout(t));
}
