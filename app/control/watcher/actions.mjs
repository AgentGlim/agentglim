// Watcher quick actions. Each reuses an Observatory function passed in at mount time (never a new write path
// into _run/ except chat_inbox/):
//   status            -> statusRefresh()                         (same as POST /api/status-refresh)
//   pause/resume/reopen a plan -> structured inbox request       ({action: "pause-plan"|"resume-plan"|"reopen-plan", plan})
//   mode or speed     -> modeRequest(key, value, until, cb)      (same validation as /api/mode)
//   approve a gate    -> markDone(id, true, note)                (same as POST /api/approvals)
//   answer an ask     -> inbox {replyTo: qid, choice}
import fs from 'node:fs';
import path from 'node:path';

export const MODE_KEY = /^(harness|reaper|(claude|codex|go)\.(mode|speed))$/;
export const MODE_VALUE = /^[a-z]{2,10}$/;
export const UNTIL = /^\d{4}-\d\d-\d\dT[\d:.+\-Z]{5,25}$/;
const PLAN = /^\d\d-[\w.-]{1,80}$/;

export function makeActions({ chat, plansDir, statusRefresh, modeRequest, markDone }) {
  const fail = (msg, code = 422) => Object.assign(new Error(msg), { code });
  async function run(b) {
    const a = b.action;
    if (a === 'status') {
      if (typeof statusRefresh !== 'function') throw fail('status refresh not available', 503);
      return { action: a, result: await statusRefresh() };
    }
    if (a === 'pause-plan' || a === 'resume-plan' || a === 'reopen-plan') {
      if (typeof b.plan !== 'string' || !PLAN.test(b.plan) || !fs.existsSync(path.join(plansDir, b.plan))) throw fail('unknown plan');
      const m = chat.post({ action: a, plan: b.plan, text: `${a} ${b.plan}` });
      return { action: a, ms: m.ms };
    }
    if (a === 'mode') {
      if (!MODE_KEY.test(b.key || '') || !MODE_VALUE.test(b.value || '') || (b.until && !UNTIL.test(b.until))) throw fail('key, value or until');
      if (typeof modeRequest !== 'function') throw fail('mode requests not available', 503);
      const r = await new Promise((ok) => modeRequest(b.key, b.value, b.until || null, (code, msg) => ok({ code, msg })));
      if (r.code !== 200) throw fail(r.msg || 'mode request failed', r.code);
      return { action: a, queued: true, msg: r.msg };
    }
    if (a === 'approve') {
      if (typeof b.id !== 'string' || !b.id || b.id.length >= 200) throw fail('unknown item');
      if (typeof markDone !== 'function') throw fail('approvals not available', 503);
      const r = markDone(b.id, true, typeof b.note === 'string' ? b.note.slice(0, 500) : 'approved on the Control page');
      if (!r) throw fail('unknown item');
      return { action: a, id: b.id, ...r };
    }
    if (a === 'answer') {
      if (!b.qid || typeof b.qid !== 'string' || b.qid.length > 80 || typeof b.choice !== 'string' || !b.choice || b.choice.length > 200) throw fail('qid and choice');
      const m = chat.post({ replyTo: b.qid, choice: b.choice, text: b.choice });
      return { action: a, ms: m.ms };
    }
    throw fail('unknown action');
  }
  return { run };
}
