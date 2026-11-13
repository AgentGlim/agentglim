#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readProgress, setProgress, taskKey } from './task-progress.mjs';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function queuedRebuild(build) {
  let tail = Promise.resolve();
  return () => { const next = tail.then(build); tail = next.catch(() => {}); return next; };
}
export function createProgressServer({ root = ROOT, port = 19008, rebuild = () => promisify(execFile)(process.execPath, [path.join(root, 'scripts/build_goals_page.mjs')], { cwd: root, timeout: 60000 }) } = {}) {
  const build = queuedRebuild(rebuild);
  const origins = new Set(['http://localhost:8000', 'http://127.0.0.1:8000', `http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    const actualPort = req.socket.localPort;
    const requestOrigins = new Set([...origins, `http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);
    if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(host) || (origin && !requestOrigins.has(origin))) { res.writeHead(403); res.end('Forbidden origin or host'); return; }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const reply = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url !== '/api/task-progress') return reply(404, { error: 'Not found' });
    if (req.method === 'GET') {
      try { return reply(200, readProgress(root)); }
      catch { return reply(500, { error: 'Progress store unreadable' }); }
    }
    if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });
    if (!origin || !requestOrigins.has(origin) || req.headers['content-type'] !== 'application/json') return reply(403, { error: 'Origin and JSON required' });
    let body = '';
    try {
      for await (const chunk of req) { body += chunk; if (body.length > 8192) return reply(413, { error: 'Too large' }); }
      const { task, status } = JSON.parse(body);
      const report = JSON.parse(fs.readFileSync(path.join(root, 'data/goals-report.json'), 'utf8'));
      const tasks = [...report.goals.flatMap(g => [...Object.values(g.do).flat(), ...g.quickWins]), ...(report.focus || [])];
      if (!tasks.some(a => a.who === 'owner' && taskKey(a.text) === task)) return reply(400, { error: 'Unknown owner task' });
      setProgress(root, task, status);
    } catch (e) { return reply(400, { error: e.message }); }
    try { await build(); reply(200, { saved: true, rebuilt: true }); }
    catch (e) { console.error('Task progress rebuild:', e.message); reply(200, { saved: true, rebuilt: false }); }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createProgressServer().listen(19008, '127.0.0.1', () => console.log('Goals task helper: 127.0.0.1:19008'));
}
