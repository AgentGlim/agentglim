// Peer-socket client for Claude's messagingSocketPath. The real peer protocol is undocumented, so this speaks a
// documented-by-us interface (newline-delimited JSON) that tests run against tests/fakes/fake-peer-socket.mjs:
//   -> {"type":"hello","protocol":1,"client":"observatory-control"}   <- {"type":"hello","ok":true,"features":[...]}
//   -> {"type":"message","id":"<id>","text":"..."}                     <- {"type":"ack","id":"<id>","ok":true}
// It is used only when control.json peer.enabled is true AND data/control/peer-handshake.json records a
// handshake (tools/peer-probe.mjs, run by the watcher after liveSend is on). It never reads *.key token files.
import net from 'node:net';
import fs from 'node:fs';
import crypto from 'node:crypto';

export function handshakeRecorded(dataDir) {
  try { const h = JSON.parse(fs.readFileSync(`${dataDir}/peer-handshake.json`, 'utf8')); return !!(h && h.ok && h.protocol >= 1); } catch { return false; }
}

function exchange(socketPath, msgs, { timeout = 3000 } = {}) {
  if (/\.key$/.test(socketPath)) return Promise.reject(new Error('refusing a .key path'));
  return new Promise((ok, fail) => {
    const s = net.createConnection(socketPath);
    const replies = []; let buf = '';
    const t = setTimeout(() => { s.destroy(); fail(new Error('peer timeout')); }, timeout);
    s.on('connect', () => { s.write(msgs.map((m) => JSON.stringify(m)).join('\n') + '\n'); });
    s.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { replies.push(JSON.parse(l)); } catch {} }
      if (replies.length >= msgs.length) { clearTimeout(t); s.end(); ok(replies); }
    });
    s.on('error', (e) => { clearTimeout(t); fail(e); });
  });
}

export async function hello(socketPath, opts) {
  const [h] = await exchange(socketPath, [{ type: 'hello', protocol: 1, client: 'observatory-control' }], opts);
  return h;
}

export async function sendText(socketPath, text, opts) {
  const id = crypto.randomBytes(6).toString('hex');
  const r = await exchange(socketPath, [{ type: 'hello', protocol: 1, client: 'observatory-control' }, { type: 'message', id, text }], opts);
  const ack = r.find((x) => x.type === 'ack' && x.id === id);
  if (!r[0]?.ok || !ack?.ok) throw new Error('peer refused');
  return { id };
}
