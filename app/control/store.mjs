// control.db (node:sqlite, WAL, 0600). Sub-item 01 owns: confirms, paused, audit, offsets, rate.
// Later sub-items add their own tables with CREATE TABLE IF NOT EXISTS in their modules.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
create table if not exists confirms (token text primary key, action text, target text, pids_json text, created integer, expires integer);
create table if not exists paused (session_id text, pid integer, proc_start integer, paused_at integer, primary key (session_id, pid));
create table if not exists audit (id integer primary key autoincrement, ts integer, listener text, device_id text, device_name text, ip text, ts_login text, action text, target text, result text, bytes integer);
create table if not exists offsets (source text, path text, offset integer, mtime integer, primary key (source, path));
create table if not exists rate (bucket text, key text, tokens real, updated integer, primary key (bucket, key));
`;

export function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'control.db');
  const db = new DatabaseSync(file);
  try { fs.chmodSync(file, 0o600); } catch {}
  db.exec('pragma journal_mode = wal; pragma busy_timeout = 2000;');
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  return {
    db, file,
    confirmPut(c) { q('insert or replace into confirms values (?,?,?,?,?,?)').run(c.token, c.action, c.target, JSON.stringify(c.pids), c.created, c.expires); },
    confirmTake(token) {
      const r = q('select * from confirms where token = ?').get(token);
      if (r) q('delete from confirms where token = ?').run(token);
      return r ? { token: r.token, action: r.action, target: r.target, pids: JSON.parse(r.pids_json), created: r.created, expires: r.expires } : null;
    },
    confirmGc(now) { q('delete from confirms where expires < ?').run(now); },
    pausedPut(sessionId, rows, at) {
      q('delete from paused where session_id = ?').run(sessionId);
      const st = q('insert into paused values (?,?,?,?)');
      for (const r of rows) st.run(sessionId, r.pid, r.procStart, at);
    },
    pausedGet(sessionId) { return q('select pid, proc_start as procStart, paused_at as at from paused where session_id = ? order by rowid').all(sessionId); },
    pausedDrop(sessionId) { q('delete from paused where session_id = ?').run(sessionId); },
    auditAdd(a) {
      return q('insert into audit (ts, listener, device_id, device_name, ip, ts_login, action, target, result, bytes) values (?,?,?,?,?,?,?,?,?,?)')
        .run(a.ts, a.listener || 'desktop', a.deviceId || null, a.deviceName || null, a.ip || null, a.tsLogin || null, a.action, a.target || null, a.result, a.bytes ?? null).lastInsertRowid;
    },
    auditList(limit = 50) { return q('select * from audit order by id desc limit ?').all(limit); },
    offsetGet(source, p) { return q('select offset, mtime from offsets where source = ? and path = ?').get(source, p) || null; },
    offsetPut(source, p, offset, mtime) { q('insert or replace into offsets values (?,?,?,?)').run(source, p, offset, mtime); },
    close() { try { db.close(); } catch {} },
  };
}
