// Small, private UI preferences. Read from disk on every request so restarts and other clients agree.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './paths.mjs';
import { sameOriginJsonRequest } from './open-url-rules.mjs';

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

function readPrefs(file) {
  try {
    const prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { theme: prefs?.theme === 'light' ? 'light' : 'dark' };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return { theme: 'dark' };
    throw error;
  }
}

export async function prefsRoute(req, res, { data = DATA } = {}) {
  const file = path.join(data, 'prefs.json');
  try {
    if (req.method === 'GET') return json(res, 200, readPrefs(file));
    if (req.method !== 'PUT') return json(res, 405, { error: 'GET or PUT only' });
    if (!sameOriginJsonRequest(req)) return json(res, 403, { error: 'forbidden' });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1024) return json(res, 413, { error: 'too large' });
    }
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'bad json' }); }
    if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || !['dark', 'light'].includes(body.theme)) {
      return json(res, 422, { error: 'theme must be dark or light' });
    }
    fs.mkdirSync(data, { recursive: true });
    // No awaits during the atomic replace: concurrent local requests cannot interleave writes.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ theme: body.theme }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return json(res, 200, { theme: body.theme });
  } catch {
    return json(res, 500, { error: 'preferences unavailable' });
  }
}
