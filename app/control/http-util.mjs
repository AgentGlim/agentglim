// Small HTTP helpers shared by the Control routes.
import fs from 'node:fs';
import path from 'node:path';

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
export const SEC_HEADERS = {
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

export function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...SEC_HEADERS });
  res.end(JSON.stringify(obj));
}

// after a 413 the rest of the body is drained (so the client can read the reply), then the socket is dropped
function res413(req) {
  setTimeout(() => { if (!req.complete) { try { req.destroy(); } catch {} } }, 1000).unref?.();
}

export function readBody(req, limit = 32 * 1024) {
  // the remote listener (sub-item 02) reads and checks the body before the route runs; reuse it, same limit rule
  if (req.obsBody !== undefined) return req.obsBodySize > limit ? Promise.reject(Object.assign(new Error('body too large'), { code: 413 })) : Promise.resolve(req.obsBody);
  return new Promise((ok, fail) => {
    let size = 0; const parts = [];
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        // answer 413 (the caller's catch writes it); drain the rest, and drop the socket once the reply is out
        over = true; parts.length = 0;
        res413(req);
        fail(Object.assign(new Error('body too large'), { code: 413 }));
        return;
      }
      parts.push(c);
    });
    req.on('end', () => {
      if (over) return;
      const s = Buffer.concat(parts).toString('utf8');
      if (!s) return ok({});
      try { const v = JSON.parse(s); ok(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch { fail(Object.assign(new Error('bad json'), { code: 400 })); }
    });
    req.on('error', fail);
  });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.md': 'text/plain; charset=utf-8' };

// serve a file from `root` only (realpath must stay inside it)
export function sendStatic(res, root, rel) {
  let real; try { real = fs.realpathSync(path.join(root, rel)); } catch { res.writeHead(404, SEC_HEADERS); return res.end('not found'); }
  const rootReal = fs.realpathSync(root);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) { res.writeHead(404, SEC_HEADERS); return res.end('not found'); }
  let st; try { st = fs.statSync(real); } catch { st = null; }
  if (!st || !st.isFile()) { res.writeHead(404, SEC_HEADERS); return res.end('not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(real)] || 'application/octet-stream', ...SEC_HEADERS, 'cache-control': 'no-cache' });
  fs.createReadStream(real).pipe(res);
}

export function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', ...SEC_HEADERS, connection: 'keep-alive' });
  res.write(': ok\n\n');
  return (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); return true; } catch { return false; } };
}
