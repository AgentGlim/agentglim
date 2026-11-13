#!/usr/bin/env node
// chat-write.mjs: the watcher's reply to the Control page's Watcher thread. Packaged in agentglim/harness/bin;
// the harness keeps a link at <plans>/_run/bin/chat-write.mjs.
//   node _run/bin/chat-write.mjs --reply "TEXT" [--to MS ...] [--ask "QUESTION" --option A --option B [--qid ID]]
// Appends one JSON line {at, reply, to?, ask?, options?, qid?} to <data>/control/watcher-in.ndjson and renames
// each answered <run>/chat_inbox/<MS>.json to <MS>.json.answered (with answeredAt). A structured ask renders as buttons;
// the owner's click comes back as an inbox file {replyTo: qid, choice}.
// Paths: CHAT_DATA_DIR (default $AGENTGLIM_DATA/control), CHAT_INBOX (default <run>/chat_inbox, run = AGENTGLIM_RUN
// or $AGENTGLIM_PLANS/_run); see harness/config.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { harnessConfig } from '../config.mjs';

const H = harnessConfig();
const DATA = process.env.CHAT_DATA_DIR || path.join(H.roots.data, 'control');
const INBOX = process.env.CHAT_INBOX || H.files.chatInbox;
const a = process.argv.slice(2), opt = { to: [], option: [] };
for (let i = 0; i < a.length; i++) {
  const k = a[i].replace(/^--/, '');
  if (!a[i].startsWith('--')) { console.error(`unexpected argument: ${a[i]}`); process.exit(2); }
  if (k === 'help') { console.log('usage: chat-write.mjs --reply TEXT [--to MS] [--ask Q --option A --option B --qid ID]'); process.exit(0); }
  const v = a[i + 1];
  if (v === undefined || v.startsWith('--')) { console.error(`--${k} needs a value`); process.exit(2); }
  i++;
  if (k === 'to' || k === 'option') opt[k].push(v); else opt[k] = v;
}
if (typeof opt.reply !== 'string' || !opt.reply.trim()) { console.error('--reply TEXT is required'); process.exit(2); }
if (opt.reply.length > 8000) { console.error('--reply is over 8000 chars'); process.exit(2); }
if (opt.to.some((m) => !/^\d{10,16}$/.test(m))) { console.error('--to takes the <ms> of an inbox file'); process.exit(2); }
if (opt.option.length && !opt.ask) { console.error('--option needs --ask'); process.exit(2); }
if (opt.ask && opt.option.length < 2) { console.error('--ask needs at least two --option'); process.exit(2); }
if (opt.option.length > 8 || opt.option.some((o) => o.length > 200)) { console.error('at most 8 options of 200 chars'); process.exit(2); }
const now = new Date().toISOString();
const rec = { at: now, reply: opt.reply, ...(opt.to.length ? { to: opt.to.length === 1 ? Number(opt.to[0]) : opt.to.map(Number) } : {}) };
if (opt.ask) Object.assign(rec, { ask: opt.ask, options: opt.option, qid: opt.qid || `q${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}` });
fs.mkdirSync(DATA, { recursive: true });
fs.appendFileSync(path.join(DATA, 'watcher-in.ndjson'), JSON.stringify(rec) + '\n', { mode: 0o600 });
const renamed = [];
for (const ms of opt.to) {
  const f = path.join(INBOX, `${ms}.json`);
  if (!fs.existsSync(f)) { console.error(`note: ${ms}.json is not pending (already answered or unknown)`); continue; }
  let j = {}; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  fs.writeFileSync(`${f}.answered`, JSON.stringify({ ...j, answeredAt: now }) + '\n');
  fs.unlinkSync(f); renamed.push(ms);
}
console.log(`chat reply written${rec.qid ? ` (ask ${rec.qid})` : ''}${renamed.length ? `; answered ${renamed.join(', ')}` : ''}`);
