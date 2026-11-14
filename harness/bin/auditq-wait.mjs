#!/usr/bin/env node
// auditq-wait.mjs - the Node twin of auditq-wait.sh for machines without bash (native Windows). Same behaviour and
// output: keeps audit_queue/.alive and heartbeats/auditq-wait fresh, exits printing STATUS:/CHAT:/CHECK:/WATCHDOG:/
// PENDING: lines as soon as there is work, or "NONE (re-arm)" after 50 minutes. Linked as <run>/bin/auditq-wait.mjs.
// Paths: AGENTGLIM_RUN, else the folder above this file's folder when it holds audit_queue, else harness config "run".
// AGENTGLIM_PLANS defaults to the folder above RUN. AGENTGLIM_WAIT_POLL / AGENTGLIM_WAIT_ROUNDS exist for tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const quote = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${String(s).replace(/"/g, '\\"')}"`);
const exists = (f) => fs.existsSync(f);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveRun(env) {
  if (env.AGENTGLIM_RUN) return env.AGENTGLIM_RUN;
  const self = process.argv[1] ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url);
  const beside = path.dirname(path.dirname(self));
  if (exists(path.join(beside, 'audit_queue'))) return beside;
  try {
    const real = fs.realpathSync(fileURLToPath(import.meta.url));
    const { harnessConfig } = await import(pathToFileURL(path.join(path.dirname(real), '..', 'config.mjs')).href);
    return harnessConfig().run;
  } catch { return beside; }
}

const list = (dir, ext) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith(ext) && fs.statSync(path.join(dir, f)).isFile()).sort(); } catch { return []; } };
const touch = (f) => { const t = new Date(); try { fs.utimesSync(f, t, t); } catch { fs.writeFileSync(f, ''); } };
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const firstLine = (f, re) => { try { return re.test(fs.readFileSync(f, 'utf8')); } catch { return false; } };

// One pass over the queues: the lines to print and whether to exit, exactly like one loop round of auditq-wait.sh.
export function scan(run, plans) {
  const Q = path.join(run, 'audit_queue'), bin = path.join(run, 'bin');
  touch(path.join(Q, '.alive')); touch(path.join(run, 'heartbeats', 'auditq-wait'));
  let pending = [];
  for (const r of list(Q, '.req')) {
    const b = path.join(Q, r.slice(0, -4)), name = path.basename(b), plan = name.split('__')[0];
    if (exists(path.join(plans, plan, 'HOLD')) && !exists(`${b}.taken`) && !exists(`${b}.decline`)) { fs.writeFileSync(`${b}.decline`, `declined by watcher ${stamp()}: plan on HOLD (owner pause)\n`); continue; }
    if (!(exists(`${b}.req.taken`) || exists(`${b}.req.decline`) || exists(`${b}.taken`) || exists(`${b}.decline`))) pending.push(name);
  }
  const lines = [];
  const reqs = (d) => list(path.join(run, d), '.json').map((f) => `${f} `).join('');
  const node = (t) => `node ${quote(path.join(bin, t))}`;
  const asks = reqs('status_ask');
  if (asks) { lines.push(`STATUS: ${asks}(owner pressed refresh now: run ${node('status-write.mjs')} --done ... --running ... --blocked ... --next ... --optimize ... with your own words; it marks the ask answered)`); if (!pending.length) return { lines, exit: true }; }
  const chats = reqs('chat_inbox');
  if (chats) { lines.push(`CHAT: ${chats}(read them, act, then: ${node('chat-write.mjs')} --reply "..." --to <ms> [--ask Q --option A --option B --qid ID])`); if (!pending.length) return { lines, exit: true }; }
  const checks = reqs('owner_check');
  if (checks) { lines.push(`CHECK: ${checks}(owner marked items done: run ${node('owner-check.mjs')} list, verify each one as deeply as it needs, then ${node('owner-check.mjs')} confirm <id> "evidence" or ${node('owner-check.mjs')} reopen <id> "what is still missing")`); if (!pending.length) return { lines, exit: true }; }
  const wd = reqs('watchdog_queue');
  if (wd) { lines.push(`WATCHDOG: ${wd}(read ${path.join(run, 'watchdog_queue')}/<file>, act or relay, then mv it into watchdog_queue/done/)`); if (!pending.length) return { lines, exit: true }; }
  if (pending.length) {
    const v = pending.filter((b) => firstLine(path.join(Q, `${b}.req`), /^role=verify/m));
    const o = pending.filter((b) => !v.includes(b));
    const c = pending.filter((b) => firstLine(path.join(Q, `${b}.req`), /^cloud=only/m));
    let text = [...v, ...o].map((b) => ` ${b}`).join('');
    if (v.length) text += ` (verify first:${v.map((b) => ` ${b}`).join('')})`;
    if (c.length) text += ` (CLOUD ONLY; leave untaken unless your own cloud automation handles it:${c.map((b) => ` ${b}`).join('')})`;
    lines.push(`PENDING:${text} (answer with the tools in ${bin}, or leave them untaken; Claude 5h window)`);
    return { lines, exit: true };
  }
  return { lines, exit: false };
}

export async function main(env = process.env, out = (s) => console.log(s)) {
  const run = await resolveRun(env);
  if (!exists(path.join(run, 'audit_queue'))) { out(`auditq-wait: no audit_queue folder under '${run}' (set AGENTGLIM_RUN)`); return 2; }
  const plans = env.AGENTGLIM_PLANS || path.dirname(run);
  const rounds = Number(env.AGENTGLIM_WAIT_ROUNDS || 200), poll = Number(env.AGENTGLIM_WAIT_POLL || 15);
  fs.mkdirSync(path.join(run, 'heartbeats'), { recursive: true });
  for (let i = 0; i < rounds; i++) {
    const r = scan(run, plans);
    for (const l of r.lines) out(l);
    if (r.exit) return 0;
    await sleep(poll * 1000);
  }
  out('NONE (re-arm)');
  return 0;
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) process.exitCode = await main();
