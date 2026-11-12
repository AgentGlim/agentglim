// Private launch registry shared with jobs-track.py. Never enumerate the Windows process table.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson } from './price-data.mjs';

export function queryWindowsProcess(pid, run = execFileSync) {
  if (!Number.isInteger(+pid) || +pid <= 1) return null;
  try {
    const row = JSON.parse(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-Process -Id ${+pid} -ErrorAction Stop; @{pid=$p.Id; start=$p.StartTime.ToFileTimeUtc().ToString(); executable=$p.Path; rss=$p.WorkingSet64} | ConvertTo-Json -Compress`],
    { encoding:'utf8', timeout:5000, windowsHide:true }));
    return row.pid === +pid && row.start && row.executable ? row : null;
  } catch { return null; }
}
export function sameWindowsIdentity(a,b) {
  return !!(a && b && a.pid === b.pid && typeof a.start === 'string' && a.start && a.start === b.start
    && typeof a.executable === 'string' && a.executable && typeof b.executable === 'string'
    && a.executable.toLowerCase() === b.executable.toLowerCase());
}
export function registeredWindowsProcesses(data) {
  const dir=path.join(data,'launched-processes');
  try { return fs.readdirSync(dir).filter(n=>/^\d+\.json$/.test(n)).map(n=>readJson(path.join(dir,n))).filter(r=>r?.pid>1 && r.start && r.executable); }
  catch { return []; }
}
export function stopWindowsProcess(pid,force=false,identity,run=execFileSync) {
  if (!Number.isInteger(+pid) || +pid<=1 || identity?.pid!==+pid || !/^\d+$/.test(identity?.start || '') || !identity?.executable)
    throw new Error('Missing launch identity');
  const exe=identity.executable.replaceAll("'", "''");
  // Pin the process object with an open handle until taskkill returns. Windows cannot
  // recycle its PID during the final identity check and the PID-based taskkill call.
  // No /T: descendants have not been individually registered or identity checked.
  const script=`$ErrorActionPreference='Stop'; $p=Get-Process -Id ${+pid}; try { $h=$p.Handle; if ($p.StartTime.ToFileTimeUtc().ToString() -ne '${identity.start}' -or $p.Path -ine '${exe}') { throw 'Process identity changed' }; & taskkill.exe /PID ${+pid}${force ? ' /F' : ''}; if ($LASTEXITCODE -ne 0) { throw 'taskkill failed' } } finally { $p.Dispose() }`;
  return run('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{timeout:5000,windowsHide:true,stdio:'ignore'});
}
