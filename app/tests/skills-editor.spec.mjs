// Playwright check for the bundled Skill Editor: the dashboard's Skill Editor link opens /skills and the editor
// lists the fixture skills and opens a file. Run: node app/tests/skills-editor.spec.mjs
// Uses dev/playwright.mjs (installed package, PLAYWRIGHT_MODULE or the private integrations path), like the tour.
import { loadPlaywright } from '../../dev/playwright.mjs';
import { fixtureServer } from './helpers/fixture-server.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { chromium } = loadPlaywright();
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
const chrome = fs.existsSync(browsers)
  ? fs.readdirSync(browsers).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
    .map((d) => path.join(browsers, d, 'chrome-linux64', 'chrome')).find((p) => fs.existsSync(p))
  : null;

const fixture = fixtureServer('ag-skills-editor-ui-');
const { home, write } = fixture;
const screenshots = process.env.THEME_SCREENSHOT_DIR;
if (screenshots) fs.mkdirSync(screenshots, { recursive: true });
write('.agents/skills/fixture-skill/SKILL.md', '---\nname: fixture-skill\ndescription: Fixture skill for the editor UI check.\n---\n\n# Fixture body\n\nThe editor should show this text.\n');
write('.agents/skills/other-skill/SKILL.md', '---\nname: other-skill\ndescription: Second fixture skill.\n---\n\n# Other\n');
write('data/skills-usage.json', JSON.stringify({
  generated: '2026-11-01T00:00:00Z',
  range: { claude: { from: '2026-10-01', to: '2026-11-01' } },
  skills: {
    'other-skill': { total: 5, calls: 5, typed: 0, loads: 0, agents: { claude: 5 }, last: '2026-11-01' },
    'fixture-skill': { total: 0, last: null },
  },
}));
// Two model suggestions for new categories, so the Accept/Reject chip and its undo are testable without a model.
write('data/skill-groups.json', JSON.stringify({
  version: 1, categories: {}, assignments: {}, hashes: {}, attempts: {}, rejected: {}, history: [],
  suggestions: [
    { id: 'new-research', categoryId: 'research', label: 'Research', skills: ['fixture-skill'], reason: 'fixture', source: 'model', at: '2026-11-12T00:00:00.000Z' },
    { id: 'new-vines', categoryId: 'vines', label: 'Vines', skills: ['other-skill'], reason: 'fixture', source: 'model', at: '2026-11-12T00:00:00.000Z' },
  ],
}, null, 2));

const ready = (page) => page.waitForFunction(() => document.documentElement.dataset.themeReady === 'true');
const isTheme = (page, theme) => page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
async function toggle(page, theme) {
  const saved = page.waitForResponse((response) => response.url().endsWith('/api/prefs') && response.request().method() === 'PUT');
  await page.click('#themeToggle');
  assert.equal((await saved).status(), 200, 'theme saves on the server');
  await isTheme(page, theme);
  const label = `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`;
  assert.equal(await page.getAttribute('#themeToggle', 'aria-label'), label);
  assert.equal(await page.getAttribute('#themeToggle', 'title'), label);
  assert.ok(await page.locator(theme === 'light' ? '.theme-moon' : '.theme-sun').isVisible());
}

// Composite translucent surfaces over their ancestors and calculate WCAG contrast from rendered sRGB.
async function contrast(page, selectors) {
  const rows = await page.evaluate((selectors) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = (color) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const over = (front, back) => { const a = front[3] / 255; return front.slice(0, 3).map((c, i) => c * a + back[i] * (1 - a)).concat(255); };
    const lum = (rgb) => rgb.slice(0, 3).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    return selectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return { selector, missing: true };
      const ancestors = []; for (let e = element; e; e = e.parentElement) ancestors.unshift(e);
      let bg = [255, 255, 255, 255];
      for (const e of ancestors) bg = over(rgba(getComputedStyle(e).backgroundColor), bg);
      const fg = rgba(getComputedStyle(element).color);
      fg[3] *= Number(getComputedStyle(element).opacity);
      const [a, b] = [lum(over(fg, bg)), lum(bg)].sort((x, y) => y - x);
      return { selector, ratio: (a + .05) / (b + .05) };
    });
  }, selectors);
  for (const row of rows) assert.ok(!row.missing && row.ratio >= 4.5, `${row.selector} light contrast ${row.ratio?.toFixed(2)}:1 (minimum 4.5)`);
  console.log('light contrast:', rows.map((r) => `${r.selector}=${r.ratio.toFixed(2)}:1`).join(', '));
}

// Geometry, icons and surfaces for the shared theme button. The button must sit inside the header control group,
// match its neighbours' height and shape, and never float over the page.
async function geometry(page, route) {
  return page.evaluate((route) => {
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
    const button = document.querySelector('#themeToggle');
    const cs = getComputedStyle(button);
    const header = document.querySelector('header').getBoundingClientRect();
    // On the dashboard the row mate is the "?" tour button. In the editor (wide) it is Home; on narrow
    // editor layouts the search field and the button share the tool row.
    const rowMate = route === '/skills/retire' ? document.querySelector('.rt-home') : route === '/skills'
      ? (document.documentElement.clientWidth <= 820 ? document.querySelector('#q') : document.querySelector('header .home'))
      : document.querySelector('#tourBtn');
    const heightMate = route === '/skills/retire' ? document.querySelector('.rt-home') : route === '/skills' ? document.querySelector('header .home') : document.querySelector('#tourBtn');
    const icons = [...button.querySelectorAll('svg')].map((svg) => {
      const s = getComputedStyle(svg), r = svg.getBoundingClientRect();
      return { cls: svg.getAttribute('class'), visible: s.visibility !== 'hidden' && Number(s.opacity) > 0 && r.width > 0, w: r.width, h: r.height, stroke: s.stroke, fill: s.fill };
    });
    return {
      header: { x: header.x, y: header.y, right: header.right, bottom: header.bottom, h: header.height },
      toggle: box(button), neighbour: box(rowMate), heightMate: box(heightMate),
      width: parseFloat(cs.width), height: parseFloat(cs.height), radius: parseFloat(cs.borderTopLeftRadius),
      inline: cs.position === 'static', color: cs.color, icons,
      viewport: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
    };
  }, route);
}

// Rendered surface luminance after compositing translucent backgrounds over their ancestors.
async function surfaces(page, selectors) {
  return page.evaluate((selectors) => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const rgba = (color) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data]; };
    const over = (front, back) => { const a = front[3] / 255; return front.slice(0, 3).map((c, i) => c * a + back[i] * (1 - a)).concat(255); };
    const lum = (rgb) => rgb.slice(0, 3).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    return selectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return { selector, missing: true };
      const ancestors = []; for (let e = element; e; e = e.parentElement) ancestors.unshift(e);
      let bg = [255, 255, 255, 255];
      for (const e of ancestors) bg = over(rgba(getComputedStyle(e).backgroundColor), bg);
      return { selector, lum: lum(bg) };
    });
  }, selectors);
}

// The shared button must look and behave like a normal header control on both pages and widths.
async function expectButton(page, route, theme) {
  // The dashboard header wraps while the live meta text is still "connecting..."; measure the settled layout.
  if (route === '/') {
    await page.waitForFunction(() => !/^connecting/.test(document.querySelector('#updated')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const g = await geometry(page, route);
  assert.ok(g.inline, `${route}: theme button is in normal flow (not absolutely positioned)`);
  assert.equal(Math.round(g.width), Math.round(g.height), `${route}: round icon button is square`);
  assert.ok(g.radius >= g.width / 2 - 0.5, `${route}: theme button is round (${g.radius}px radius)`);
  assert.ok(g.toggle.y >= g.header.y - 1 && g.toggle.bottom <= g.header.bottom + 1, `${route}: theme button stays inside the header`);
  assert.ok(g.heightMate && Math.abs(g.height - g.heightMate.h) <= 1, `${route}: theme height ${g.height} matches the other header buttons (${g.heightMate?.h})`);
  assert.ok(g.neighbour && Math.abs(g.toggle.y - g.neighbour.y) <= 1, `${route}: theme button shares a row with its neighbour`);
  assert.ok(g.viewport - g.toggle.right <= 48, `${route}: theme button sits at the right edge of the header`);
  assert.ok(g.scrollWidth <= g.viewport, `${route}: no horizontal overflow`);
  const shown = g.icons.filter((icon) => icon.visible);
  assert.equal(shown.length, 1, `${route}: exactly one theme icon is visible`);
  assert.equal(shown[0].w, 18, `${route}: icon is 18 px wide`);
  assert.equal(shown[0].h, 18, `${route}: icon is 18 px tall`);
  assert.equal(shown[0].stroke, g.color, `${route}: icon stroke follows currentColor`);
  assert.equal(shown[0].fill, 'none', `${route}: icon is stroke-only`);
  assert.equal(shown[0].cls, theme === 'light' ? 'theme-moon' : 'theme-sun', `${route}: ${theme} shows the icon of the theme it switches to`);
  return g;
}

// Every major surface must visibly change between dark and light, and light surfaces must stay light.
function expectSurfaces(theme, rows) {
  for (const row of rows) {
    assert.ok(!row.missing, `${row.selector} exists`);
    if (theme === 'light') assert.ok(row.lum > 0.5, `${row.selector} stays light in light mode (luminance ${row.lum?.toFixed(2)})`);
    else assert.ok(row.lum < 0.2, `${row.selector} is dark in dark mode (luminance ${row.lum?.toFixed(2)})`);
  }
}

let browser;
try {
  let base = await fixture.start();
  browser = await chromium.launch(chrome ? { executablePath: chrome } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { try { localStorage.setItem('agTourSeen', '1'); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#skillsLink', { state: 'attached', timeout: 20000 });
  // Skill Editor is its own top-level header button now, not a Pages menu item: no menu needed, visible at once.
  assert.equal(await page.$$eval('#pgMenu #skillsLink', (els) => els.length), 0, 'the Skill Editor link left the Pages menu');
  assert.equal(await page.$$eval('header .hdr-r > a#skillsLink', (els) => els.length), 1, 'Skill Editor is a top-level header button');
  assert.equal(await page.$$eval('header .hdr-r > #themeToggle', (els) => els.length), 1, 'theme button lives in the header control group');
  assert.ok(await page.locator('#skillsLink').isVisible(), 'the header Skill Editor button is visible without opening anything');
  assert.equal(await page.textContent('#skillsLink'), 'Skill Editor');
  await ready(page); await isTheme(page, 'dark');
  await expectButton(page, '/', 'dark');
  const dashboardPanels = ['body', 'header', '.card', '#statusCard', '.chip', '#agentNote'];
  const dashboardDark = await surfaces(page, dashboardPanels);
  expectSurfaces('dark', dashboardDark);
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'dashboard-desktop-dark.png') });

  // Keyboard: Tab reaches the button, Enter and Space both flip it, and the label follows.
  await page.focus('#tourBtn'); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'themeToggle', 'Tab reaches the theme button');
  const ring = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('#themeToggle')); return { style: s.outlineStyle, width: s.outlineWidth }; });
  assert.notEqual(ring.style, 'none', 'keyboard focus shows a visible ring');
  assert.ok(parseFloat(ring.width) >= 2, `focus ring is at least 2 px (${ring.width})`);
  const enterSave = page.waitForResponse((response) => response.url().endsWith('/api/prefs') && response.request().method() === 'PUT');
  await page.keyboard.press('Enter');
  assert.equal((await enterSave).status(), 200, 'Enter saves the theme');
  await isTheme(page, 'light');
  assert.equal(await page.getAttribute('#themeToggle', 'aria-label'), 'Switch to dark theme', 'label follows Enter');
  await expectButton(page, '/', 'light');
  const spaceSave = page.waitForResponse((response) => response.url().endsWith('/api/prefs') && response.request().method() === 'PUT');
  await page.keyboard.press('Space');
  assert.equal((await spaceSave).status(), 200, 'Space saves the theme');
  await isTheme(page, 'dark');
  assert.equal(await page.getAttribute('#themeToggle', 'aria-label'), 'Switch to light theme', 'label follows Space');

  await toggle(page, 'light');
  await page.reload({ waitUntil: 'domcontentloaded' }); await ready(page); await isTheme(page, 'light');
  await expectButton(page, '/', 'light');
  const dashboardLight = await surfaces(page, dashboardPanels);
  expectSurfaces('light', dashboardLight);
  for (const [i, row] of dashboardLight.entries()) {
    assert.ok(row.lum - dashboardDark[i].lum > 0.3, `${row.selector} visibly changes between dark and light (${dashboardDark[i].lum.toFixed(2)} -> ${row.lum.toFixed(2)})`);
  }
  await contrast(page, ['body', '#updated', '#skillsLink', '.card h2', '.chip', '.btn', '#themeToggle', '#agentNoteText']);
  if (screenshots) await page.screenshot({ path: path.join(screenshots, 'dashboard-desktop-light.png') });
  const popupP = ctx.waitForEvent('page');
  await page.click('#skillsLink');
  const editor = await popupP;
  const editorErrors = [];
  const editorConsoleErrors = [];
  editor.on('pageerror', (e) => editorErrors.push(e.message));
  editor.on('console', (m) => { if (m.type() === 'error') editorConsoleErrors.push(m.text()); });
  await editor.waitForLoadState('domcontentloaded');
  assert.match(editor.url(), /\/skills$/, 'the Skill Editor link opens /skills');
  await editor.waitForSelector('#tm .tile', { timeout: 20000 });
  await ready(editor); await isTheme(editor, 'light');
  assert.equal(await editor.title(), 'Skill Editor · AgentGlim');
  assert.equal(await editor.textContent('h1'), 'Skill Editor');
  const retireBox = await editor.locator('#retireLink').boundingBox();
  const headingBox = await editor.locator('header h1').boundingBox();
  assert.ok(retireBox && headingBox && retireBox.x + retireBox.width <= headingBox.x + 1, 'Skills to retire sits left of the heading');
  assert.equal(await editor.$$eval('header #themeToggle', (els) => els.length), 1, 'the editor header has the same theme button');
  await expectButton(editor, '/skills', 'light');
  const editorPanels = ['body', 'header', '#tm .tile', '.foot'];
  const editorLight = await surfaces(editor, editorPanels);
  expectSurfaces('light', editorLight);
  await contrast(editor, ['body', '#count', '.home', '#themeToggle', '#tm .tile b', '.foot']);
  if (screenshots) await editor.screenshot({ path: path.join(screenshots, 'editor-desktop-light.png') });
  // Keyboard on the editor too: Tab from the search field, then Enter flips and saves.
  await editor.focus('#q'); await editor.keyboard.press('Tab');
  assert.equal(await editor.evaluate(() => document.activeElement.id), 'themeToggle', 'Tab reaches the editor theme button');
  const editorSave = editor.waitForResponse((response) => response.url().endsWith('/api/prefs') && response.request().method() === 'PUT');
  await editor.keyboard.press('Enter');
  assert.equal((await editorSave).status(), 200, 'the editor saves the theme from the keyboard');
  await isTheme(editor, 'dark'); await isTheme(page, 'dark');
  await expectButton(editor, '/skills', 'dark');
  const editorDark = await surfaces(editor, editorPanels);
  expectSurfaces('dark', editorDark);
  for (const [i, row] of editorDark.entries()) {
    assert.ok(editorLight[i].lum - row.lum > 0.3, `${row.selector} visibly changes between dark and light in the editor`);
  }
  if (screenshots) await editor.screenshot({ path: path.join(screenshots, 'editor-desktop-dark.png') });
  await editor.reload({ waitUntil: 'domcontentloaded' }); await ready(editor); await isTheme(editor, 'dark');
  await expectButton(editor, '/skills', 'dark');
  await toggle(editor, 'light'); await isTheme(page, 'light');
  await editor.reload({ waitUntil: 'domcontentloaded' }); await ready(editor); await isTheme(editor, 'light');
  const ids = await editor.$$eval('#tm .tile', (els) => els.map((e) => e.dataset.id));
  assert.ok(ids.includes('fixture-skill'), `editor lists fixture skills (${ids.join(', ')})`);
  assert.match(await editor.textContent('#count'), /skills/);

  // Regression (owner 2026-11-13, "uses and colours disappeared"): usage must reach the map at boot. The bug was
  // loadUsage() resolving to undefined, so boot's `U = r[0] || {skills:{}}` wiped it; with every skill then at
  // 0 uses, every tile fell back to the grey `.zero` style -- which reads as "the colours are gone" too.
  const usedTile = editor.locator('#tm .tile[data-id="other-skill"]');
  assert.match(await usedTile.locator('small').textContent(), /5 uses/, 'a used skill shows its usage count at boot');
  assert.equal(await usedTile.evaluate((el) => el.classList.contains('zero')), false, 'a used skill is not greyed out as zero');
  assert.ok(await editor.$$eval('#tm .tile', (els) => els.every((e) => [...e.classList].some((c) => /^c-/.test(c)))), 'every tile carries its category colour class');
  assert.match(await editor.textContent('#count'), /5 recorded uses/, 'the header reports the recorded uses');

  // Regression (owner 2026-11-13, "not refreshing"): the atlas is built once at boot, so a skill added, retired
  // or edited on disk while the editor is open must still reach the open page via the live refresh
  // (focus/visibility + interval) -- not only after a full reload. Uses and colours must survive that refresh.
  write('.agents/skills/live-added/SKILL.md', '---\nname: live-added\ndescription: Added to disk while the editor was open.\n---\n\n# Added later\n');
  assert.equal(await editor.locator('#tm .tile[data-id="live-added"]').count(), 0, 'the new skill is not on the map yet (the atlas was built before it existed)');
  await editor.evaluate(() => {
    try { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); } catch {}
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
  await editor.waitForSelector('#tm .tile[data-id="live-added"]', { timeout: 15000 });
  assert.match(editor.url(), /\/skills$/, 'the editor picked up the new skill in place, without navigating away');
  assert.match(await editor.locator('#tm .tile[data-id="other-skill"] small').textContent(), /5 uses/, 'usage counts survive a live refresh');
  assert.equal(await editor.locator('#tm .tile[data-id="other-skill"]').evaluate((el) => el.classList.contains('zero')), false, 'tile colour (non-zero) survives a live refresh');

  // Auto-grouping chips: Reject removes one, Accept applies the other, Undo puts the chip back.
  const chips = () => editor.$$eval('#gbarList .gchip', (els) => els.map((e) => e.dataset.suggestion));
  assert.deepEqual((await chips()).sort(), ['new-research', 'new-vines'], 'both suggestions show as chips');
  assert.equal(await editor.locator('#undoMove').isHidden(), true, 'nothing to undo yet');
  const rejectSaved = editor.waitForResponse((r) => r.url().endsWith('/api/skills/groups/reject') && r.request().method() === 'POST');
  await editor.click('button[data-group-act="reject"][data-id="new-vines"]');
  assert.equal((await rejectSaved).status(), 200, 'Reject saves to the data folder');
  await editor.waitForFunction(() => document.querySelectorAll('#gbarList .gchip').length === 1);
  assert.deepEqual(await chips(), ['new-research'], 'the rejected chip is gone');
  assert.equal(await editor.locator('#undoMove').isVisible(), true, 'Reject is undoable');

  const acceptSaved = editor.waitForResponse((r) => r.url().endsWith('/api/skills/groups/accept') && r.request().method() === 'POST');
  await editor.click('button[data-group-act="accept"][data-id="new-research"]');
  assert.equal((await acceptSaved).status(), 200, 'Accept saves to the data folder');
  await editor.waitForFunction(() => document.querySelectorAll('#gbarList .gchip').length === 0);
  await editor.waitForFunction(() => [...document.querySelectorAll('#tm .blk h2')].some((h) => /Research/.test(h.textContent)));
  const headings = await editor.$$eval('#tm .blk h2', (els) => els.map((e) => e.textContent));
  assert.ok(headings.some((h) => /Research/.test(h)), `the new category is a block on the map (${headings.join(', ')})`);
  assert.ok(await editor.locator('#tm .tile[data-id="fixture-skill"]').count(), 'the moved tile is still on the map');

  const undoDone = editor.waitForResponse((r) => r.url().endsWith('/api/skills/groups/undo') && r.request().method() === 'POST');
  await editor.click('#undoMove');
  assert.equal((await undoDone).status(), 200, 'Undo saves to the data folder');
  await editor.waitForFunction(() => document.querySelectorAll('#gbarList .gchip').length === 1);
  assert.deepEqual(await chips(), ['new-research'], 'Undo brings the accepted chip back');
  await editor.waitForFunction(() => ![...document.querySelectorAll('#tm .blk h2')].some((h) => /Research/.test(h.textContent)));
  assert.equal(await editor.locator('#undoMove').isVisible(), true, 'the earlier Reject is still undoable');

  const undoReject = editor.waitForResponse((r) => r.url().endsWith('/api/skills/groups/undo') && r.request().method() === 'POST');
  await editor.click('#undoMove');
  assert.equal((await undoReject).status(), 200, 'the Reject is undone too');
  await editor.waitForFunction(() => document.querySelectorAll('#gbarList .gchip').length === 2);
  assert.deepEqual((await chips()).sort(), ['new-research', 'new-vines'], 'both chips are back');
  assert.equal(await editor.locator('#undoMove').isHidden(), true, 'nothing left to undo');

  const groups = await (await fetch(base + '/api/skills/groups')).json();
  assert.equal(groups.suggestions.length, 2);
  assert.equal(groups.assignments['fixture-skill'], undefined);
  const groupLog = fs.readFileSync(path.join(home, 'data/skill-group-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(groupLog.map((r) => r.action).filter((a) => a !== 'move'), ['reject', 'accept', 'undo', 'undo'], 'every decision is logged');

  await editor.click('#tm .tile[data-id="fixture-skill"]');
  await editor.waitForSelector('#focus:not([hidden])');
  await editor.click('button[data-open="SKILL.md"]');
  await editor.waitForFunction(() => { const t = document.querySelector('#ed .se-ta'); return t && !t.hidden && /Fixture body/.test(t.value); }, null, { timeout: 15000 });
  await contrast(editor, ['.center p', '.se-ta', '.se-ed-foot', '.se-gutter']);
  if (screenshots) await editor.screenshot({ path: path.join(screenshots, 'editor-file-light.png') });
  assert.ok(fs.existsSync(path.join(home, '.agents/skills/fixture-skill/SKILL.md')), 'reading a file never moves it');
  assert.deepEqual(editorErrors, [], 'no page errors in the editor');
  assert.deepEqual(editorConsoleErrors, [], 'no console errors in the editor');
  assert.deepEqual(consoleErrors, [], 'no console errors on the dashboard');

  // Skills to retire: the header button opens the live page; the list renders from fixture usage; back returns.
  const retireErrors = [];
  editor.on('console', (m) => { if (m.type() === 'error') retireErrors.push(m.text()); });
  await editor.click('#retireLink');
  await editor.waitForURL(/\/skills\/retire$/, { timeout: 15000 });
  await editor.waitForSelector('#waffle button', { timeout: 15000 });
  await ready(editor); await isTheme(editor, 'light');
  assert.equal(await editor.title(), 'Skills to Retire · AgentGlim');
  const retired = await editor.$$eval('#waffle button', (els) => els.map((e) => e.getAttribute('aria-label')));
  assert.ok(retired.includes('fixture-skill') && retired.includes('other-skill'), `retire lists fixture skills (${retired.join(', ')})`);
  assert.match(await editor.textContent('#tables'), /other-skill \(5\)/, 'usage counts come from the live usage file');
  assert.match(await editor.textContent('#tables'), /Keep/, 'the keep section renders');
  const retireOverflow = await editor.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(retireOverflow <= 0, `retire page: no horizontal overflow at 1280 px (${retireOverflow})`);
  await contrast(editor, ['body', 'h1', '#meta', '.rt-home', '#plan-btn', '#detail h3']);
  if (screenshots) await editor.screenshot({ path: path.join(screenshots, 'retire-desktop-light.png') });
  await toggle(editor, 'dark');
  await toggle(editor, 'light');
  await editor.click('.rt-home');
  await editor.waitForURL(/\/skills$/);
  await editor.waitForSelector('#tm .tile', { timeout: 15000 });
  await ready(editor); await isTheme(editor, 'light');
  assert.deepEqual(retireErrors, [], 'no console errors on the retire page');
  assert.deepEqual(editorErrors, [], 'no page errors in the editor or the retire page');

  // A fresh browser cache still reads the server choice. Restart the process on another free port too.
  await fixture.stop(); base = await fixture.start();
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await mobile.addInitScript(() => { try { localStorage.setItem('agTourSeen', '1'); } catch {} });
  const mpage = await mobile.newPage();
  for (const route of ['/', '/skills', '/skills/retire']) {
    await mpage.goto(base + route, { waitUntil: 'domcontentloaded' });
    await ready(mpage); await isTheme(mpage, 'light');
    if (route === '/skills') await mpage.waitForSelector('#tm .tile');
    if (route === '/skills/retire') await mpage.waitForSelector('#waffle button');
    for (const theme of ['dark', 'light']) {
      await toggle(mpage, theme);
      await mpage.reload({ waitUntil: 'domcontentloaded' }); await ready(mpage); await isTheme(mpage, theme);
      const overflow = await mpage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `${route} ${theme}: no horizontal overflow at 390 px (${overflow})`);
      await expectButton(mpage, route, theme);
      if (screenshots) await mpage.screenshot({ path: path.join(screenshots, `${route === '/' ? 'dashboard' : route === '/skills' ? 'editor' : 'retire'}-mobile-${theme}.png`) });
    }
  }
  // The saved choice survives a server restart in both themes, for both pages.
  for (const theme of ['dark', 'light']) {
    if ((await mpage.evaluate(() => document.documentElement.dataset.theme)) !== theme) await toggle(mpage, theme);
    await fixture.stop(); base = await fixture.start();
    for (const route of ['/', '/skills']) {
      await mpage.goto(base + route, { waitUntil: 'domcontentloaded' });
      await ready(mpage); await isTheme(mpage, theme);
      if (route === '/skills') await mpage.waitForSelector('#tm .tile');
      await expectButton(mpage, route, theme);
    }
  }
  // Block the server read to verify that the synchronous cache determines the first rendered frame.
  const cached = await browser.newContext();
  await cached.addInitScript(() => {
    localStorage.setItem('agTourSeen', '1');
    if (!localStorage.getItem('agentglim.theme')) localStorage.setItem('agentglim.theme', 'light');
    requestAnimationFrame(() => { window.firstTheme = document.documentElement.dataset.theme; });
  });
  await cached.route('**/api/prefs', (route) => route.abort());
  const cpage = await cached.newPage();
  for (const route of ['/', '/skills']) {
    await cpage.goto(base + route, { waitUntil: 'domcontentloaded' });
    await cpage.waitForFunction(() => window.firstTheme);
    assert.equal(await cpage.evaluate(() => window.firstTheme), 'light', `${route}: cache applies before first paint`);
  }
  await cached.unroute('**/api/prefs');
  // The authoritative server preference reconciles a stale browser cache.
  await cpage.evaluate(() => localStorage.setItem('agentglim.theme', 'dark'));
  await cpage.reload({ waitUntil: 'domcontentloaded' }); await ready(cpage); await isTheme(cpage, 'light');
  await cached.close();
  await mobile.close();
  assert.deepEqual(errors, [], 'no dashboard page errors');
  console.log(`PASS: Skill Editor lists ${ids.length} skills and opens SKILL.md; Skills to retire opens live and returns; shared themes, reloads, restart, contrast and all pages at 390 px`);
} finally {
  if (browser) await browser.close();
  await fixture.close();
}
