// Process controls on recorded pids only. The tree comes from /proc ppid links (bwrap and setsid children have
// their own process groups, so killpg is not enough). Every signal re-checks the pid's procStart; a mismatch
// drops that pid. Never by name or pattern. Never this process or one of its ancestors.
export function makeSignals({ proc, kill = (pid, sig) => process.kill(pid, sig), selfPid = process.pid, killGraceMs = 5000 } = {}) {
  const protectedPids = () => { const s = new Set([0, 1]); let p = selfPid, n = 0; while (p > 1 && n++ < 64) { s.add(p); const st = proc.stat(p); if (!st) break; p = st.ppid; } return s; };

  // the tree under `pid`, parent first, each with its procStart and command (for the confirm summary)
  function snapshotTree(pid) {
    const prot = protectedPids();
    return proc.tree(pid).filter((p) => !prot.has(p)).map((p) => {
      const st = proc.stat(p);
      return st ? { pid: p, procStart: st.starttime, comm: st.comm, cmd: proc.cmdline(p).join(' ').slice(0, 160), pgid: st.pgid } : null;
    }).filter(Boolean);
  }

  // send `sig` to recorded rows (in the given order); returns {sent:[pid], dropped:[{pid, why}]}
  function signalRows(rows, sig) {
    const prot = protectedPids(), sent = [], dropped = [];
    for (const r of rows) {
      if (prot.has(r.pid)) { dropped.push({ pid: r.pid, why: 'protected' }); continue; }
      const now = proc.procStart(r.pid);
      if (now == null) { dropped.push({ pid: r.pid, why: 'gone' }); continue; }
      if (String(now) !== String(r.procStart)) { dropped.push({ pid: r.pid, why: 'procStart mismatch (pid reused)' }); continue; }
      try { kill(r.pid, sig); sent.push(r.pid); } catch (e) { dropped.push({ pid: r.pid, why: e.code || 'error' }); }
    }
    return { sent, dropped };
  }

  const pause = (rows) => signalRows(rows, 'SIGSTOP'); // parent first (rows come parent first)
  const resume = (rows) => signalRows([...rows].reverse(), 'SIGCONT'); // children first
  function kill_(rows) {
    const first = signalRows(rows, 'SIGTERM');
    const done = new Promise((ok) => {
      const t = setTimeout(() => {
        const left = rows.filter((r) => first.sent.includes(r.pid) && proc.procStart(r.pid) != null && String(proc.procStart(r.pid)) === String(r.procStart) && proc.stat(r.pid)?.state !== 'Z');
        ok({ term: first, kill: signalRows(left, 'SIGKILL') });
      }, killGraceMs);
      t.unref?.();
    });
    return { term: first, done };
  }
  const interruptPid = (row) => signalRows([row], 'SIGINT');
  return { snapshotTree, signalRows, pause, resume, kill: kill_, interruptPid, protectedPids };
}
