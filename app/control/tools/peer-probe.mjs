#!/usr/bin/env node
// peer-probe.mjs: record a peer-socket handshake with ONE throwaway Claude session the owner started for it (DEFERRED F01-2).
//   node control/tools/peer-probe.mjs --pid <pid> --data <_observatory/data/control> --i-started-this-session-for-the-probe
// Refuses unless control.json liveSend is true. Reads <CLAUDE_HOME>/sessions/<pid>.json (never the .key token file),
// checks procStart, sends only the hello of the documented-by-us interface (no message text), and writes the reply to
// <data>/peer-handshake.json. peer.enabled stays false until the owner sets it after reading that file.
import fs from 'node:fs';
import path from 'node:path';
import { hello } from '../sessions/peer-socket.mjs';
import { makeProc } from '../sessions/procscan.mjs';

const a = process.argv.slice(2);
const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
const pid = Number(opt('--pid')), data = opt('--data'), home = process.env.CLAUDE_HOME || `${process.env.HOME}/.claude`;
if (!(pid > 1) || !data || !a.includes('--i-started-this-session-for-the-probe')) { console.error('usage: peer-probe.mjs --pid N --data DIR --i-started-this-session-for-the-probe'); process.exit(2); }
let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(path.join(data, 'control.json'), 'utf8')); } catch {}
if (cfg.liveSend !== true) { console.error('refusing: liveSend is false in control.json'); process.exit(3); }
const reg = JSON.parse(fs.readFileSync(path.join(home, 'sessions', `${pid}.json`), 'utf8'));
const st = makeProc(process.env.PROC_ROOT || '/proc').stat(pid);
if (!st || String(st.starttime) !== String(reg.procStart)) { console.error('refusing: pid not alive or procStart mismatch'); process.exit(3); }
if (!reg.messagingSocketPath || /\.key$/.test(reg.messagingSocketPath)) { console.error('no messagingSocketPath'); process.exit(3); }
let rec;
try { const h = await hello(reg.messagingSocketPath, { timeout: 3000 }); rec = { at: new Date().toISOString(), pid, version: reg.version || null, peerProtocol: reg.peerProtocol ?? null, ok: !!h?.ok, protocol: h?.protocol ?? null, reply: h }; }
catch (e) { rec = { at: new Date().toISOString(), pid, version: reg.version || null, peerProtocol: reg.peerProtocol ?? null, ok: false, error: String(e.message || e) }; }
fs.writeFileSync(path.join(data, 'peer-handshake.json'), JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(rec, null, 2));
process.exit(rec.ok ? 0 : 1);
