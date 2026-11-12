// Audit rows: target, action, result and byte counts. Never message text, prompt text, PINs, tokens or cookies.
import fs from 'node:fs';
import path from 'node:path';

const MAX = 5 * 1024 * 1024, KEEP = 5;
const ALLOWED = ['ts', 'listener', 'deviceId', 'deviceName', 'ip', 'tsLogin', 'action', 'target', 'result', 'bytes', 'dryRun', 'reason'];

export function makeAudit(store, dataDir) {
  const file = path.join(dataDir, 'audit.ndjson');
  function rotate() {
    let size = 0; try { size = fs.statSync(file).size; } catch { return; }
    if (size < MAX) return;
    for (let i = KEEP - 1; i >= 1; i--) { try { fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`); } catch {} }
    try { fs.renameSync(file, `${file}.1`); } catch {}
    try { fs.unlinkSync(`${file}.${KEEP + 1}`); } catch {}
  }
  return function audit(row) {
    const r = { ts: Date.now() };
    for (const k of ALLOWED) if (row[k] !== undefined) r[k] = row[k];
    if (typeof r.action === 'string') r.action = r.action.slice(0, 60);
    if (typeof r.target === 'string') r.target = r.target.slice(0, 200);
    if (typeof r.reason === 'string') r.reason = r.reason.slice(0, 200);
    try { store.auditAdd({ ...r, result: r.dryRun ? `dry-run:${r.result}` : r.result }); } catch (e) { console.error('control audit db', e.message); }
    try { rotate(); fs.appendFileSync(file, JSON.stringify(r) + '\n', { mode: 0o600 }); } catch (e) { console.error('control audit file', e.message); }
    return r;
  };
}
