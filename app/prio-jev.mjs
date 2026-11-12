// prio-jev.mjs: give every plan with no priority a tier. Jev is the first pass; when it is
// unsure (best tier p < 0.5) the plan is still labeled with Jev's best guess, marked unsure, and an Opus review
// job goes to the audit queue (the watcher takes it) to confirm or correct the tier in data/priorities.json.
// Run: node prio-jev.mjs [--dry]. The server runs it every 30 min; it only asks about plans that are missing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jevAsk, jevBest } from './classify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
import { PLANS, WORK, DATA } from './paths.mjs';
const PRIO = `${DATA}/priorities.json`;
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const head = (f, n) => { try { return fs.readFileSync(f, 'utf8').slice(0, n); } catch { return ''; } };

export async function labelMissing({ dry = false } = {}) {
  const p = readJson(PRIO, null);
  if (!p?.projects) return { error: 'no priorities.json' };
  const dirs = (fs.existsSync(PLANS) ? fs.readdirSync(PLANS) : []).filter((d) => /^\d\d-/.test(d) && fs.statSync(`${PLANS}/${d}`).isDirectory()).sort();
  const missing = dirs.filter((d) => !p.projects[d]);
  const out = [];
  for (const dir of missing) {
    const desc = (head(`${PLANS}/${dir}/SKELETON.md`, 1500) || head(`${PLANS}/${dir}/PLAN.md`, 1500) || head(`${PLANS}/${dir}/INTAKE.md`, 1500)).replace(/\s+/g, ' ');
    const cat = readJson(`${PLANS}/categories.json`, {}).plans?.[dir.slice(0, 2)] || 'unknown';
    const state = `A plans harness ranks build plans for its owner. Ranking basis: ${p.basis} Plan "${dir}" (area ${cat}): ${desc}`;
    const questions = {};
    for (const [t, d] of Object.entries(p.tiers)) questions[`t_${t}`] = { type: 'noul', instructions: `Does this plan belong in tier ${t}: ${d}?` };
    const r = await jevAsk(state, questions, `prio:${dir}`);
    if (r.error) { out.push({ dir, error: r.error }); continue; }
    const b = jevBest(r.answers, 't_');
    if (!b) { out.push({ dir, error: 'no answer' }); continue; }
    const tier = Number(String(b[0]).replace(/^t_/, '')), pr = b[1];
    const sure = pr >= 0.5;
    const rank = Math.max(0, ...Object.values(p.projects).filter((x) => x.tier === tier).map((x) => x.rank || 0)) + 1;
    const why = `Auto (Jev, p=${pr.toFixed(2)}${sure ? '' : ', unsure: Opus review queued'}): ${p.tiers[tier]}`;
    const entry = { tier, rank, why, by: 'jev', p: Number(pr.toFixed(3)), at: new Date().toISOString() };
    out.push({ dir, ...entry });
    if (dry) continue;
    p.projects[dir] = entry;
    if (!sure) queueOpus(dir, entry, desc);
  }
  if (!dry && out.some((o) => o.tier)) fs.writeFileSync(PRIO, JSON.stringify(p, null, 2));
  return { missing: missing.length, out };
}

function queueOpus(dir, entry, desc) {
  const slug = `prio-${dir}-${Date.now().toString(36)}`;
  const d = `${WORK}/_build/${slug}`, req = `${PLANS}/_run/audit_queue/observatory__${slug}.req`;
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(`${d}/prompt.md`, `# Observatory: confirm an auto priority tier

Jev (first pass) put plan ${dir} in tier ${entry.tier} but was unsure (p=${entry.p}).
Read ${PLANS}/${dir}/SKELETON.md (or PLAN.md / INTAKE.md), ${PLANS}/plan.md and ${DATA}/priorities.json
(its basis, tiers and the ranks of similar plans). Decide the right tier (1-3) and a rank that fits the list.
Edit only the "${dir}" entry in ${DATA}/priorities.json: set tier, rank, why (one plain line, no names),
by: "opus-review". Keep the file valid JSON. Then write ${d}/REPORT.md: first line = the verdict
("tier N confirmed" or "tier A -> B because ..."). Write nowhere else.

Plan summary: ${desc.slice(0, 800)}
`);
  fs.writeFileSync(req, `model=opus\nprompt=${d}/prompt.md\ndone=${d}/claude.done\n`);
}

if (path.resolve(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url))) {
  console.log(JSON.stringify(await labelMissing({ dry: process.argv.includes('--dry') }), null, 1));
}
