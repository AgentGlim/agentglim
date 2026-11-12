// /proc reading with an injectable root (tests use tests/fixtures/proc or a temp copy).
// agentKind rules ported from _observatory/others.mjs (claude, codex, pi, opencode; node/bun launchers);
// a child of the same kind as its parent is folded into the parent.
import fs from 'node:fs';
import path from 'node:path';

// io: low-level readers. Default: files under procRoot. Tests and the dev server pass an overlay io
// (fake entries plus a whitelist of real pids they spawned).
export function fileIO(procRoot = '/proc') {
  const P = (pid, f) => path.join(procRoot, String(pid), f);
  return {
    root: procRoot,
    stat: (pid) => { try { return fs.readFileSync(P(pid, 'stat'), 'utf8'); } catch { return null; } },
    cmdline: (pid) => { try { return fs.readFileSync(P(pid, 'cmdline'), 'utf8'); } catch { return null; } },
    cwd: (pid) => { try { return fs.readlinkSync(P(pid, 'cwd')); } catch { try { return fs.readFileSync(P(pid, 'cwd.txt'), 'utf8').trim(); } catch { return null; } } },
    // boot time in seconds since the epoch (`btime` in <root>/stat); null when unknown
    btime: () => { try { const m = fs.readFileSync(path.join(procRoot, 'stat'), 'utf8').match(/^btime (\d+)$/m); return m ? Number(m[1]) : null; } catch { return null; } },
    pids: () => { try { return fs.readdirSync(procRoot).filter((p) => /^\d+$/.test(p)).map(Number); } catch { return []; } },
    fds: (pid) => { const out = []; let names = []; try { names = fs.readdirSync(P(pid, 'fd')); } catch { return out; } for (const n of names) { try { out.push(fs.readlinkSync(path.join(P(pid, 'fd'), n))); } catch {} } return out; },
  };
}

export function parseStat(pid, s) {
  if (!s) return null;
  const a = s.indexOf('('), b = s.lastIndexOf(')');
  if (a < 0 || b < 0) return null;
  const rest = s.slice(b + 2).trim().split(/\s+/);
  return { pid: Number(pid), comm: s.slice(a + 1, b), state: rest[0], ppid: Number(rest[1]), pgid: Number(rest[2]), sid: Number(rest[3]), tty: Number(rest[4]), starttime: Number(rest[19]) };
}

export function makeProc(rootOrIO = process.env.PROC_ROOT || '/proc') {
  const io = typeof rootOrIO === 'string' ? fileIO(rootOrIO) : rootOrIO;
  const procRoot = io.root || null;
  const stat = (pid) => parseStat(pid, io.stat(pid));
  const procStart = (pid) => stat(pid)?.starttime ?? null;
  // wall-clock start of a process in ms (boot time + starttime / CLK_TCK); null when the boot time is unknown
  const CLK_TCK = Number(process.env.PROC_CLK_TCK) || 100;
  function startMs(pid) {
    const st = stat(pid); if (!st) return null;
    const bt = io.btime ? io.btime(pid) : null;
    return bt == null ? null : Math.round((bt + st.starttime / CLK_TCK) * 1000);
  }
  function cmdline(pid) { const s = io.cmdline(pid); if (!s) return []; const a = s.split('\0'); if (a.at(-1) === '') a.pop(); return a; }
  const cwd = (pid) => io.cwd(pid);
  const pids = () => io.pids();
  const fds = (pid) => io.fds ? io.fds(pid) : [];
  function agentKind(comm, pid) {
    if (comm === 'claude' || comm === 'codex' || comm === 'pi') return comm;
    if (/^\.?opencode/.test(comm)) return 'opencode';
    if (comm !== 'node' && comm !== 'bun' && comm !== 'MainThread') return null;
    const a = cmdline(pid);
    const bin = path.basename(a[1] || '');
    return bin === 'codex' || bin === 'codex.js' ? 'codex' : bin === 'opencode' ? 'opencode' : /pi-coding-agent/.test(a[1] || '') ? 'pi' : bin === 'claude' || /claude-code\/cli/.test(a[1] || '') ? 'claude' : null;
  }
  // one row per agent process; a process whose parent is an agent of the same kind is folded into it
  function scanAgents({ skipPid = process.pid } = {}) {
    const seen = new Map();
    for (const pid of pids()) {
      if (pid === skipPid) continue;
      const st = stat(pid); if (!st) continue;
      const kind = agentKind(st.comm, pid); if (!kind) continue;
      seen.set(pid, { pid, ppid: st.ppid, pgid: st.pgid, kind, comm: st.comm, state: st.state, starttime: st.starttime, cwd: cwd(pid), argv: cmdline(pid) });
    }
    const out = [];
    for (const a of seen.values()) {
      if (seen.get(a.ppid)?.kind === a.kind) continue;
      // children of the same kind (folded): kept so the tree knows them
      a.folded = [...seen.values()].filter((c) => c.ppid === a.pid && c.kind === a.kind).map((c) => c.pid);
      out.push(a);
    }
    return out;
  }
  // every pid in the tree under `root` (ppid links over all of /proc, so setsid/bwrap children count), parent first
  function tree(root) {
    const kids = new Map();
    for (const pid of pids()) { const st = stat(pid); if (!st) continue; (kids.get(st.ppid) || kids.set(st.ppid, []).get(st.ppid)).push(pid); }
    const out = [], q = [Number(root)], seen = new Set();
    if (!stat(root)) return out;
    while (q.length) { const p = q.shift(); if (seen.has(p)) continue; seen.add(p); out.push(p); for (const c of kids.get(p) || []) q.push(c); }
    return out;
  }
  // true when `anc` is `pid` or one of its ancestors
  function isAncestor(anc, pid) {
    let p = Number(pid), n = 0;
    while (p > 1 && n++ < 64) { if (p === Number(anc)) return true; const st = stat(p); if (!st) return false; p = st.ppid; }
    return p === Number(anc);
  }
  return { root: procRoot, stat, procStart, startMs, cmdline, cwd, pids, fds, agentKind, scanAgents, tree, isAncestor };
}

// argument value from an argv array: --model X or --model=X
export function argOf(argv, ...names) {
  for (let i = 0; i < argv.length; i++) for (const n of names) {
    if (argv[i] === n && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith(`${n}=`)) return argv[i].slice(n.length + 1);
  }
  return null;
}
export const headlessOf = (kind, argv) => kind === 'claude' ? argv.includes('-p') || argv.includes('--print')
  : kind === 'codex' ? argv.includes('exec') : kind === 'opencode' ? argv.includes('run') : kind === 'pi' ? argv.includes('-p') || argv.includes('--print') : false;
