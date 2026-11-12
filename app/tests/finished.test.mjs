// "Finished in the last N days" strip: server window (7 days max), clamp, label, and the page wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { clampDays, lastDoneAt, finishedWithin, finishedLabel, FINISHED_MAX_DAYS } from '../finished.mjs';

const DAY = 86400e3, now = Date.parse('2026-11-12T12:00:00Z');
const rows = [
  { dir: '01-a', at: now - 2 * 3600e3, pct: 95 },
  { dir: '02-b', at: now - 30 * 3600e3, pct: 91 },
  { dir: '03-c', at: now - 2.5 * DAY, pct: null },
  { dir: '04-d', at: now - 6.9 * DAY, pct: 88 },
  { dir: '05-e', at: now - 8 * DAY, pct: 99 },
  { dir: '06-f', at: null, pct: 99 },
];

test('days are whole numbers from 1 to 7, anything else falls back', () => {
  assert.equal(FINISHED_MAX_DAYS, 7);
  assert.deepEqual([undefined, null, 'x', 0, -3, NaN].map((v) => clampDays(v)), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual([1, 3, '3', 3.9, 7, 8, 99].map((v) => clampDays(v)), [1, 3, 3, 3, 7, 7, 7]);
});

test('the window follows the chosen days, capped at 7, newest first', () => {
  const dirs = (d) => finishedWithin(rows, now, d).map((r) => r.dir);
  assert.deepEqual(dirs(1), ['01-a']); // 30 h is outside 24 h
  assert.deepEqual(dirs(2), ['01-a', '02-b']);
  assert.deepEqual(dirs(3), ['01-a', '02-b', '03-c']);
  assert.deepEqual(dirs(7), ['01-a', '02-b', '03-c', '04-d']);
  assert.deepEqual(dirs(30), dirs(7), 'the cap is 7 days');
  assert.deepEqual(dirs(undefined), dirs(1));
});

test('lastDoneAt takes the newest done event of a plan', () => {
  const ev = [{ t: 5, verb: 'advance', text: 'v1-verify -> done (ok)' }, { t: 6, verb: 'launch', text: 'v2' }, { t: 9, verb: 'advance', text: 'v2-verify -> done (ok)' }, { t: 10, verb: 'advance', text: 'v3 -> v3-r1 (ok)' }];
  assert.equal(lastDoneAt(ev), 9);
  assert.equal(lastDoneAt([]), null);
  assert.equal(lastDoneAt(undefined), null);
});

test('the label follows the choice', () => {
  assert.equal(finishedLabel(1), 'finished in the last 24 h');
  assert.equal(finishedLabel(3), 'finished in the last 3 days');
  assert.equal(finishedLabel(50), 'finished in the last 7 days');
});

test('the page has the 1-7 dropdown, remembers it in localStorage and filters by it; the server sends 7 days', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="stFinDays"/);
  assert.match(html, /\[1, 2, 3, 4, 5, 6, 7\]\.map\(\(n\) => `<option value="\$\{n\}"/);
  assert.match(html, /localStorage\.getItem\('obsFinishedDays'\)/);
  assert.match(html, /localStorage\.setItem\('obsFinishedDays'/);
  assert.match(html, /d\.finished\.filter\(\(f\) => f\.at >= cut\)/);
  assert.match(html, /finished in the last \$\{n\} days/);
  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(srv, /finishedWithin\(finishedRows, now, FINISHED_MAX_DAYS\)/);
});

// The plan table under the strip follows the same window (owner bug 2026-11-12: only the chips changed).
import { plansInWindow, doneLabel } from '../finished.mjs';
const P = (dir, state, hAgo, extra = {}) => ({ dir, state, last: hAgo == null ? null : { t: now - hAgo * 3600e3 }, doneAt: state === 'done' ? now - (hAgo ?? 0) * 3600e3 : null, ...extra });
// server list: live, held, pinned, and done plans that moved in the last 24 h
const listed = [P('66-build', 'running', 4), P('70-leads', 'held', 13), P('69-pentest', 'done', 0.2), P('55-remote', 'done', 250, { doneAt: null })];
// done plans whose last event is 1-7 days old (server field olderDone)
const older = [P('11-sprint', 'done', 32), P('61-rpg', 'done', 35), P('53-top3', 'done', 149), P('99-bad', 'held', 30)];

test('the plan table follows the window: 1 day = the server list, 2 and 7 days add older done plans', () => {
  const dirs = (d) => plansInWindow(listed, older, now, d).map((p) => p.dir);
  assert.deepEqual(dirs(1), ['66-build', '55-remote', '69-pentest', '70-leads']);
  assert.deepEqual(dirs(2), ['66-build', '11-sprint', '55-remote', '61-rpg', '69-pentest', '70-leads']);
  assert.deepEqual(dirs(7), ['66-build', '11-sprint', '53-top3', '55-remote', '61-rpg', '69-pentest', '70-leads']);
  const n = [1, 2, 3, 4, 5, 6, 7].map((d) => plansInWindow(listed, older, now, d).length);
  for (let i = 1; i < n.length; i++) assert.ok(n[i] >= n[i - 1], `rows never shrink as the window widens: ${n}`);
  for (const d of [1, 2, 7]) {
    const rows = plansInWindow(listed, older, now, d);
    assert.deepEqual(rows.filter((p) => p.state !== 'done').map((p) => p.dir), ['66-build', '70-leads'], 'live and held rows stay as they are');
  }
  assert.ok(!dirs(7).includes('99-bad'), 'only done plans come from olderDone');
  assert.deepEqual(dirs(30), dirs(7));
  assert.deepEqual(plansInWindow(listed, undefined, now, 7).map((p) => p.dir), dirs(1), 'an old digest without olderDone still renders');
});

test('the done label follows the window', () => {
  assert.equal(doneLabel(1), 'done today');
  assert.equal(doneLabel(2), 'done in 2 days');
  assert.equal(doneLabel(7), 'done in 7 days');
  assert.equal(doneLabel(undefined), 'done today');
});

test('the page builds the table, picker, charts and done tile from the window; the server sends olderDone', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /const stDoneL = \(n\) => \(n === 1 \? 'done today' : `done in \$\{n\} days`\)/);
  assert.match(html, /\(d\.olderDone \|\| \[\]\)\.filter\(\(p\) => p\.state === 'done' && p\.last\?\.t >= cut\)/);
  assert.match(html, /Date\.now\(\) - stFinDays \* 86400e3; return \[\.\.\.d\.plans/);
  assert.match(html, /const vis = stWin\(d\); ST_L\.done = stDoneL\(stFinDays\);/);
  assert.match(html, /<div class="stlist">\$\{vis\.map\(/);
  assert.match(html, /const cp = vis\.filter\(/);
  assert.match(html, /\['done', vis\.filter\(\(p\) => p\.state === 'done' && p\.doneAt\)\.length\]/);
  assert.doesNotMatch(html, /<div class="stlist">\$\{d\.plans\.map\(/);
  const srv = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.match(srv, /const into = dropped \? olderDone : plans;/);
  assert.match(srv, /if \(dropped && !\(state === 'done' && last && now - last\.t < FINISHED_MAX_DAYS \* DAY\)\) continue;/);
  assert.match(srv, /plans, olderDone, line,/);
});
