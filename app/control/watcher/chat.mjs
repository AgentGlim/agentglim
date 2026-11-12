// Pinned Watcher thread. Sending writes <RUN>/chat_inbox/<ms>.json ({at, from:"control", text, replyTo?, action?})
// and appends to <data>/watcher-out.ndjson; the watcher wakes on auditq-wait.sh "CHAT:" and answers with
// _run/bin/chat-write.mjs, which appends to <data>/watcher-in.ndjson and renames <ms>.json -> <ms>.json.answered.
// The inbox is a file for the watcher to read, not a keystroke into a session; the optional peer-socket copy
// goes through the liveSend guard like every other send.
import fs from 'node:fs';
import path from 'node:path';

const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
export const MAX_CHAT = 8000;

export function makeChat({ dataDir, runDir, now = () => Date.now() }) {
  const inbox = path.join(runDir, 'chat_inbox');
  const outF = path.join(dataDir, 'watcher-out.ndjson'), inF = path.join(dataDir, 'watcher-in.ndjson');
  function post(msg) {
    fs.mkdirSync(inbox, { recursive: true });
    let ms = now();
    while (fs.existsSync(path.join(inbox, `${ms}.json`)) || fs.existsSync(path.join(inbox, `${ms}.json.answered`))) ms += 1;
    const rec = { at: new Date(ms).toISOString(), from: 'control', ...msg };
    const tmp = path.join(inbox, `.${ms}.json.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(rec) + '\n');
    fs.renameSync(tmp, path.join(inbox, `${ms}.json`));
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(outF, JSON.stringify({ ms, ...rec }) + '\n', { mode: 0o600 });
    return { ms, ...rec };
  }
  function state(ms) {
    if (fs.existsSync(path.join(inbox, `${ms}.json.answered`))) return 'answered';
    if (fs.existsSync(path.join(inbox, `${ms}.json`))) return 'pending';
    return 'unknown';
  }
  // the thread: my messages and the watcher's replies, oldest first; asks carry options and whether they were answered
  function thread(limit = 200) {
    const out = readLines(outF).map((m) => ({ kind: 'out', ms: m.ms, at: m.at, text: m.text || null, action: m.action || null, plan: m.plan || null, replyTo: m.replyTo || null, choice: m.choice ?? null, state: state(m.ms) }));
    const answeredQ = new Set(out.filter((m) => m.replyTo).map((m) => String(m.replyTo)));
    const ins = readLines(inF).map((m) => ({ kind: 'in', at: m.at, ms: Date.parse(m.at) || 0, text: m.reply || '', to: m.to ?? null,
      ask: m.ask ? { question: m.ask, options: Array.isArray(m.options) ? m.options.slice(0, 8) : [], qid: m.qid || null, answered: m.qid ? answeredQ.has(String(m.qid)) : false } : null }));
    return [...out, ...ins].sort((a, b) => (Date.parse(a.at) || a.ms) - (Date.parse(b.at) || b.ms)).slice(-limit);
  }
  const mtime = () => { let t = 0; for (const f of [outF, inF]) { try { t = Math.max(t, fs.statSync(f).mtimeMs); } catch {} } try { t = Math.max(t, fs.statSync(inbox).mtimeMs); } catch {} return t; };
  return { post, thread, mtime, inbox, outF, inF };
}
