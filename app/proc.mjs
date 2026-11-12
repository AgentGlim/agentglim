import fs from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';

// ps and CIM expose command text, not argv. Recover quoted arguments without
// executing the text. Windows backslashes only escape quotes, not path letters.
function splitArgs(text, windows = false) {
  const args = [];
  let value = '', quote = '', started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (windows && c === '\\') {
      let end = i;
      while (text[end] === '\\') end++;
      const count = end - i;
      if (text[end] === '"') {
        value += '\\'.repeat(Math.floor(count / 2));
        if (count % 2) value += '"';
        else quote = quote ? '' : '"';
        i = end;
      } else { value += '\\'.repeat(count); i = end - 1; }
      started = true;
    } else if (!windows && c === '\\' && quote !== "'" && i + 1 < text.length) {
      value += text[++i]; started = true;
    } else if (c === '"' || (!windows && c === "'")) {
      if (!quote) quote = c;
      else if (quote === c) quote = '';
      else value += c;
      started = true;
    } else if (/\s/.test(c) && !quote) {
      if (started) args.push(value);
      value = ''; started = false;
    } else { value += c; started = true; }
  }
  if (started) args.push(value);
  return args;
}

export function parsePs(text) {
  try {
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/);
      if (!m) continue;
      rows.push({ pid: +m[1], ppid: +m[2], comm: m[5],
        args: splitArgs(m[6] || ''), cwd: null,
        tty: /^(?:\?\??|-)$/.test(m[4]) ? 0 : m[4], state: m[3] });
    }
    return rows;
  } catch { return []; }
}

export function parseCim(json) {
  try {
    const parsed = JSON.parse(json.replace(/^\uFEFF/, ''));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows.filter(row => row && Number.isInteger(row.ProcessId) && row.ProcessId >= 0
      && Number.isInteger(row.ParentProcessId) && row.ParentProcessId >= 0
      && typeof row.Name === 'string').map(row => ({
      pid: row.ProcessId, ppid: row.ParentProcessId, comm: row.Name,
      args: typeof row.CommandLine === 'string' ? splitArgs(row.CommandLine, true) : [],
      cwd: null, tty: 0, state: '', // CIM does not supply a Unix process state or tty.
    }));
  } catch { return []; }
}

// CIM can take seconds even on a healthy Windows machine. Never block the
// HTTP event loop on PowerShell; share one in-flight query and a short-lived
// snapshot across dashboard, driver and watcher readers.
export function createWindowsProcessLister({ run = execFile, now = Date.now, ttl = 5000 } = {}) {
  let rows = [], pending = false, expires = 0;
  return () => {
    if (!pending && now() >= expires) {
      pending = true;
      const done = (error, output) => {
        rows = error ? [] : parseCim(output);
        expires = now() + ttl;
        pending = false;
      };
      try {
        run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          'Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json'],
        { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, done);
      } catch (error) { done(error); }
    }
    return rows;
  };
}
const windowsProcesses = createWindowsProcessLister();

export function listProcesses() {
  try {
    const options = { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024, windowsHide: true };
    if (process.platform === 'darwin') {
      return parsePs(execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,tty=,comm=,args='], options));
    }
    if (process.platform === 'win32') {
      return windowsProcesses();
    }
    if (process.platform !== 'linux') return [];
    const rows = [];
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const dir = `/proc/${pid}`;
        const stat = fs.readFileSync(`${dir}/stat`, 'utf8');
        const end = stat.lastIndexOf(')');
        const fields = stat.slice(end + 2).split(' ');
        const args = fs.readFileSync(`${dir}/cmdline`, 'utf8').split('\0');
        if (args.at(-1) === '') args.pop();
        let cwd = null;
        try { cwd = fs.readlinkSync(`${dir}/cwd`); } catch {}
        rows.push({ pid: +pid, ppid: +fields[1], comm: stat.slice(stat.indexOf('(') + 1, end),
          args, cwd, tty: +fields[4], state: fields[0] });
      } catch { /* Processes can exit or deny access during the scan. */ }
    }
    return rows;
  } catch { return []; }
}

// Keep Linux's available-memory accounting; other platforms may omit it.
export function readMemoryInfo() {
  if (process.platform !== 'linux') throw new Error('Memory info unavailable');
  return Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').map(line => line.split(/:\s+/)).filter(parts => parts[1]).map(([key, value]) => [key, parseInt(value) * 1024]));
}
