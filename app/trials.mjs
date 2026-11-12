// Trials: live reader for the three running harness trials (HARNESS.md 3.8).
// Reads _run/effort-trial.json and the Claude driver sessions in _run/claude-home since the trial start; cached 60 s.
import fs from 'node:fs';
import path from 'node:path';

const PRICE = { opus: [4.0, 0.20, 5.0, 20.0], sonnet: [2.0, 0.10, 2.5, 10.0], haiku: [0.10, 0.01, 0.125, 0.50] }; // same table as session-review/prep.py
const START = Date.parse('2026-11-04T13:26:00-06:00');
const fam = (m) => { m = (m || '').toLowerCase(); return m.includes('opus') ? 'opus' : m.includes('haiku') ? 'haiku' : m.includes('sonnet') ? 'sonnet' : null; };
const ROLE_RE = /# Role: ([a-z ()-]+?) for plans\/([0-9]{2}-[a-z0-9-]+), round ([a-z0-9-]+)(?:, task ([A-Za-z0-9_.-]+))?/;
function classify(p) {
  p = p || ''; let m = ROLE_RE.exec(p);
  if (m) { const r = m[1]; return [r.includes('auditor') ? 'auditor' : r.includes('verifier') ? 'verifier' : r.includes('checker') ? 'focus-check' : r.includes('orchestrator') ? 'orchestrator' : r.includes('worker') ? 'worker' : r, m[2], m[3], m[4] || '']; }
  m = /prompt file: \S*\/plans\/([0-9]{2}-[a-z0-9-]+)\/_build\/([a-z0-9-]+)\/(?:(audit|workers?\/[^/\s]+|orch\w*)\/)?prompt\.md/.exec(p);
  if (m) { const sub = m[3] || '', st = m[2]; return [sub === 'audit' ? 'auditor' : sub.startsWith('worker') ? 'worker' : sub.startsWith('orch') ? 'orchestrator' : st.includes('verify') ? 'verifier' : st.includes('focus') ? 'focus-check' : 'other', m[1], st, sub.startsWith('worker') ? sub.split('/')[1] || '' : '']; }
  return ['other', '', '', ''];
}
const ex = (f) => { try { return fs.statSync(f).size > 0; } catch { return false; } };

export function makeTrials({ RUN, PLANS, readText }) {
  const SRC = `${RUN}/claude-home/projects`, cache = new Map(); let out = null, outAt = 0;
  function parse(f) {
    let prompt = null, t0 = null, turns = 0, maxctx = 0, cost = 0; const seen = new Set(), tok = { input: 0, write: 0, read: 0, output: 0 };
    for (const raw of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!raw) continue; let d; try { d = JSON.parse(raw); } catch { continue; }
      if (d.timestamp && !t0) t0 = d.timestamp;
      const msg = d.message || {};
      if (d.type === 'user' && !d.isSidechain && prompt == null && typeof msg.content === 'string') prompt = msg.content;
      else if (d.type === 'assistant') {
        const u = msg.usage; if (!msg.id || seen.has(msg.id) || !u) continue; seen.add(msg.id); turns++;
        const i = u.input_tokens || 0, w = u.cache_creation_input_tokens || 0, r = u.cache_read_input_tokens || 0, o = u.output_tokens || 0, fm = fam(msg.model);
        tok.input += i; tok.write += w; tok.read += r; tok.output += o; if (fm) { const p = PRICE[fm]; cost += (i * p[0] + r * p[1] + w * p[2] + o * p[3]) / 1e6; }
        maxctx = Math.max(maxctx, i + w + r);
      }
    }
    if (!turns) return null;
    const [role, plan, round, task] = classify(prompt);
    return { id: path.basename(f, '.jsonl'), role, plan: plan || path.basename(path.dirname(f)).replace(/^-home-user-dev-projects-plans-?/, ''), round, task, start: t0, turns, tokens: tok, outTok: tok.output, allTok: tok.input + tok.write + tok.read + tok.output, cost: +cost.toFixed(3), maxCtx: maxctx, file: path.relative(PLANS, f) };
  }
  function sessions() {
    const res = []; let dirs = []; try { dirs = fs.readdirSync(SRC); } catch { return res; }
    for (const dd of dirs) { let fs_ = []; try { fs_ = fs.readdirSync(`${SRC}/${dd}`).filter((x) => x.endsWith('.jsonl')); } catch { continue; }
      for (const x of fs_) { const f = `${SRC}/${dd}/${x}`; let st; try { st = fs.statSync(f); } catch { continue; }
        if (st.mtimeMs < START) continue; const k = `${st.mtimeMs}:${st.size}`, c = cache.get(f);
        if (c && c.k === k) { if (c.s) res.push(c.s); continue; }
        let s = null; try { s = parse(f); } catch {} cache.set(f, { k, s }); if (s) res.push(s); } }
    return res.filter((s) => s.start && Date.parse(s.start) >= START);
  }
  const avg = (a, f) => a.length ? a.reduce((t, x) => t + f(x), 0) / a.length : 0;
  function build() {
    const all = sessions().sort((a, b) => a.start < b.start ? -1 : 1);
    const row = (s, extra) => ({ id: s.id, plan: s.plan, step: s.round + (s.task ? '/' + s.task : ''), at: s.start, cost: s.cost, tokens: s.allTok, out: s.outTok, peakCtx: s.maxCtx, ...extra });
    // baselines from session-review/sessions.json (high-effort focus/verify runs); falls back to fixed numbers
    let base = []; try { base = JSON.parse(readText(`${RUN}/session-review/sessions.json`)); } catch {}
    const hi = base.filter((s) => s.role === 'verifier' || s.role === 'focus-check');
    // orchestrators
    const orch = all.filter((s) => s.role === 'orchestrator').slice(0, 10);
    const orchRows = orch.map((s) => row(s, { outcome: ex(`${PLANS}/${s.plan}/_build/${s.round}/AUDIT.md`) ? 'round audited' : 'running or no audit yet', files: `${s.plan}/_build/${s.round}/` }));
    const wk = all.filter((s) => s.role === 'worker').slice(0, 20);
    const wkRows = wk.map((s) => row(s, { outcome: ex(`${PLANS}/${s.plan}/_build/${s.round}/workers/${s.task}/DONE`) ? 'DONE' : 'no DONE', files: `${s.plan}/_build/${s.round}/workers/${s.task}/` }));
    // effort trial
    let et = { left: 0, runs: [] }; try { et = JSON.parse(readText(`${RUN}/effort-trial.json`)); } catch {}
    const prem = all.filter((s) => s.role === 'verifier' || s.role === 'focus-check');
    const effRows = (et.runs || []).map((r) => {
      const t = Date.parse(r.at), s = prem.find((x) => x.plan === r.dir && Date.parse(x.start) >= t - 120e3 && Date.parse(x.start) <= t + 6 * 3600e3);
      const done = ex(`${PLANS}/${r.dir}/_build/${r.step === 'focus' ? 'focus' : r.step}/VERIFY.md`) || ex(`${PLANS}/${r.dir}/_build/${r.step}/FOCUS.md`);
      return s ? row(s, { plan: r.dir, step: r.step, at: r.at, outcome: done ? 'output written' : 'running or no output yet', files: `${r.dir}/_build/` })
        : { id: '', plan: r.dir, step: r.step, at: r.at, cost: null, tokens: null, out: null, peakCtx: null, outcome: 'no Claude session matched (Codex job, or still starting)', files: `${r.dir}/_build/` };
    });
    const mk = (id, name, target, rows, metric, baseline, revert, what, hib) => {
      const n = rows.length, mv = metric(rows), bv = baseline.value;
      let verdict = 'pending'; if (n >= target && mv != null) verdict = hib(mv, bv) ? 'better' : 'worse';
      return { id, name, what, target, n: Math.min(n, target), runs: rows, current: mv, baseline, verdict, revert };
    };
    const trials = [
      mk('effort', 'Premium effort', 5, effRows,
        (r) => { const c = r.filter((x) => x.cost != null); return c.length ? { label: 'avg cost', value: +avg(c, (x) => x.cost).toFixed(2), unit: '$' } : null; },
        { label: 'avg cost, high-effort focus/verify runs', value: +avg(hi, (s) => s.cost).toFixed(2), unit: '$', n: hi.length, peakCtx: Math.round(avg(hi, (s) => s.max_ctx)) },
        'set "left": 0 in _run/effort-trial.json', 'driver.mjs premEffort() runs premium focus/verify jobs at medium instead of high effort; counts the next 5 jobs (live since the driver restart 2026-11-04 13:26).', (a, b) => a.value <= b),
      mk('orchestrator', 'Orchestrator briefs', 10, orchRows,
        (r) => r.length ? { label: 'avg output tokens', value: Math.round(avg(r, (x) => x.out)), unit: 'tok', cost: +avg(r, (x) => x.cost).toFixed(2) } : null,
        { label: 'avg output tokens', value: 14200, unit: 'tok', cost: 0.39, n: 342 },
        'restore _run/prompts/orchestrator.md.bak-20261104-review over orchestrator.md', 'Shorter worker briefs in _run/prompts/orchestrator.md; counts the next 10 orchestrator sessions. Watch for any worker failing on a thin brief.', (a, b) => a.value <= b),
      mk('worker', 'Worker task size', 20, wkRows,
        (r) => r.length ? { label: 'avg peak context', value: Math.round(avg(r, (x) => x.peakCtx)), unit: 'tok', over100k: Math.round(100 * r.filter((x) => x.peakCtx > 100000).length / r.length), done: Math.round(100 * r.filter((x) => x.outcome === 'DONE').length / r.length) } : null,
        { label: 'avg peak context', value: 154000, unit: 'tok', over100k: 75, n: 776 },
        'restore _run/prompts/orchestrator.md.bak-20261104-review over orchestrator.md', 'Smaller tasks per worker (same orchestrator.md change); counts the next 20 Claude worker sessions.', (a, b) => a.value <= b),
    ];
    // effort trial also reports the runs left on the counter
    trials[0].left = et.left;
    return { at: Date.now(), start: new Date(START).toISOString(), trials };
  }
  return { get() { if (!out || Date.now() - outAt > 60e3) { try { out = build(); outAt = Date.now(); } catch (e) { out = out || { at: Date.now(), trials: [], error: String(e) }; } } return out; } };
}
