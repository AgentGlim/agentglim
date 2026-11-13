#!/usr/bin/env node
// owner-check.mjs - the watcher's side of the Status card "done" button (owner 2026-11-01).
// The owner clicks done on a blocker; it stays open as "waiting for the watcher's check" until the watcher runs:
//   node _run/bin/owner-check.mjs list                    claims waiting for a check (with item detail)
//   node _run/bin/owner-check.mjs confirm <id> "evidence"  verified: marks the approval item done
//   node _run/bin/owner-check.mjs reopen  <id> "reason"    not done yet: back on the card with the reason
//   node _run/bin/owner-check.mjs pin   <id> "why"         float an item to the top of the ranked blockers
//   node _run/bin/owner-check.mjs unpin <id>
//   node _run/bin/owner-check.mjs pins                     show pins
// Check each claim as deeply as it needs (read files, run read-only checks, look at logs); write evidence, not a guess.
// Packaged in agentglim/harness/bin (imports the app's modules directly); the harness keeps a link at <run>/bin/owner-check.mjs.
import { readClaims, resolveClaim, readPins, PINS_FILE } from '../../app/blockers.mjs';
import { approvals, markDone } from '../../app/approvals.mjs';
import fs from 'node:fs';

const [cmd, id, ...rest] = process.argv.slice(2), text = rest.join(' ').trim();
const die = (m) => { console.error(m); process.exit(2); };
if (cmd === 'list') {
  const c = readClaims(), items = new Map(approvals(0).items.map((i) => [i.id, i])), open = Object.entries(c).filter(([, x]) => x.state === 'checking');
  if (!open.length) { console.log('no claims waiting for a check'); process.exit(0); }
  for (const [k, x] of open) { const it = items.get(k) || {};
    console.log(`- ${k}\n  ${x.project}: ${x.title}\n  owner said done ${x.at}${x.note ? `: "${x.note}"` : ''}${it.detail ? `\n  detail: ${it.detail}` : ''}${x.src ? `\n  source: ${x.src}` : ''}${x.cmd ? `\n  suggested command: ${x.cmd}` : ''}`); }
} else if (cmd === 'confirm' || cmd === 'reopen') {
  if (!id || !text) die(`usage: owner-check.mjs ${cmd} <id> "${cmd === 'confirm' ? 'evidence' : 'reason'}"`);
  const r = resolveClaim(id, cmd === 'confirm' ? 'confirmed' : 'reopened', text); if (!r) die(`no claim for ${id}`);
  if (cmd === 'confirm' && !markDone(id, true, `owner said done; watcher confirmed: ${text}`.slice(0, 500))) console.error(`note: ${id} is not a known approval item any more; the claim is closed anyway`);
  console.log(`${id}: ${r.state}`);
} else if (cmd === 'pin' || cmd === 'unpin') {
  if (!id) die(`usage: owner-check.mjs ${cmd} <id> ["why"]`);
  const p = readPins().filter((x) => x.id !== id); if (cmd === 'pin') p.push({ id, why: text, at: new Date().toISOString() });
  fs.writeFileSync(`${PINS_FILE}.tmp`, JSON.stringify({ items: p }, null, 1) + '\n'); fs.renameSync(`${PINS_FILE}.tmp`, PINS_FILE);
  console.log(`${cmd === 'pin' ? 'pinned' : 'unpinned'} ${id} (${p.length} pins)`);
} else if (cmd === 'pins') { for (const p of readPins()) console.log(`- ${p.id}: ${p.why}`); }
else die('usage: owner-check.mjs list | confirm <id> "evidence" | reopen <id> "reason" | pin <id> "why" | unpin <id> | pins');
