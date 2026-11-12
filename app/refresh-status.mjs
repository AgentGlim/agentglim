// A refresh is local and deterministic; it does not impersonate an agent reply.
export function liveStatus(digest, { stop = '', modes = {}, at = new Date().toISOString() } = {}) {
  const t = digest.tally, running = digest.plans.filter(p => p.state === 'running');
  const alerts = (digest.flags || []).filter(f => f.level === 'critical').slice(0, 3).map(f => f.text);
  const lines = {
    done: `${t.doneAll} of ${t.total} plans marked done.`,
    running: `${digest.driverAlive ? 'Driver on' : 'Driver off'}; ${running.length} plans active${running.length ? ': ' + running.map(p => p.dir + ' (' + p.stage + ')').join(', ') : ''}. Codex mode: ${modes.subs?.codex?.mode || 'unknown'}.`,
    blocked: stop ? `New launches stopped: ${stop.trim()}` : alerts.join(' ') || 'No critical alerts detected in the current snapshot.',
    next: stop ? 'Investigate the launch stop before resuming new jobs.' : t.gate ? `${t.gate} plans await your audit.` : 'Continue monitoring active jobs and queued work.',
    optimize: 'Automatic status from current harness data; no agent reply is required.'
  };
  return { at, linesAt: at, source: 'live', mode: modes.harness || 'unknown', driverAlive: digest.driverAlive, counts: t, lines };
}
