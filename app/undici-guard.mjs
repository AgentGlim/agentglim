// Crash guard for Node's built-in fetch (undici), added 2026-11-06.
// Root cause: undici's HTTP/1 parser asserts `!this.paused` (Parser.finish, from Socket 'end') when a response that
// is NOT keep-alive (Connection: close or HTTP/1.0) has its body stream paused for backpressure at the moment the
// server closes the socket. The body is still unread then because fetch() resolves on headers and the 'end' tick
// runs before the caller's .json(). It is a race inside undici, so it hits even code that does read the body.
// Confirmed cause (reproduced): GET /skills probed the Skill Editor (python http.server, HTTP/1.0, ~70 KB page, more
// than the ~64 KB stream buffer) with fetch() and never read the body, so every /skills open crashed the server.
// dev-skills.mjs now probes with node:http. local.mjs's :8096/slots probe (llama-server sends Connection: close on
// every 100th keep-alive request) moved to node:http too as a precaution; its 5 KB body is under the buffer.
// This guard only keeps the server up if some other fetch hits the same race: it logs the assertion with the
// fetches in flight and keeps serving. Every other uncaught exception still logs and exits 1, as before.
import dc from 'node:diagnostics_channel';

const inflight = new Map(); // undici request -> { url, t, status, conn }
const label = (r) => `${r.method || 'GET'} ${r.origin || ''}${r.path || ''}`;
dc.subscribe('undici:request:create', ({ request }) => { inflight.set(request, { url: label(request), t: Date.now() }); });
dc.subscribe('undici:request:headers', ({ request, response }) => {
  const e = inflight.get(request); if (!e) return;
  e.status = response.statusCode;
  const h = response.headers || []; // raw [name, value, ...] buffers
  for (let i = 0; i < h.length; i += 2) if (String(h[i]).toLowerCase() === 'connection') e.conn = String(h[i + 1]);
});
const done = ({ request }) => { inflight.delete(request); };
dc.subscribe('undici:request:trailers', done);
dc.subscribe('undici:request:error', done);
setInterval(() => { const old = Date.now() - 10 * 60e3; for (const [r, e] of inflight) if (e.t < old) inflight.delete(r); }, 60e3).unref();

let hits = 0;
const isUndiciPaused = (err) => err?.code === 'ERR_ASSERTION' && /this\.paused/.test(String(err.message))
  && /undici/.test(String(err.stack));
process.on('uncaughtException', (err, origin) => {
  if (isUndiciPaused(err)) {
    hits++;
    const now = Date.now();
    const list = [...inflight.values()].map((e) => `${e.url} status=${e.status ?? '-'} conn=${e.conn ?? '-'} age=${now - e.t}ms`);
    console.error(`[undici-guard] ${new Date().toISOString()} caught undici assert(!this.paused) #${hits}, kept serving. in flight: ${list.join(' | ') || 'none'}`);
    return;
  }
  console.error(origin === 'unhandledRejection' ? 'Unhandled rejection:' : 'Uncaught exception:', err);
  process.exit(1);
});
