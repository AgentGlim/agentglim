// Every sample-number figure on the public site carries a visible "demo data" caption; the honest
// "What it looks like for you" section, the install link and the send-to-agent copy are present.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SITE_DIR = path.resolve(import.meta.dirname, '../../site');
// the site is split into pages (site/PAGES.md); check them all together
const siteHtml = () => fs.readdirSync(SITE_DIR).filter(f => f.endsWith('.html')).sort().map(f => fs.readFileSync(path.join(SITE_DIR, f), 'utf8')).join('\n');
// the public export ships the app without site/; skip the page checks there
const NO_SITE = fs.existsSync(SITE_DIR) ? false : 'site/ is not in this checkout';
const DEMO_SHOT = /assets\/img\/shot-(?!real-)[\w-]+\.(?:jpg|png|webp)/;
const TAG = /<span class="demo">demo data<\/span>/;

// returns the problems: a demo shot outside a captioned figure, or a data-demo block without the tag
export function demoCaptionProblems(html) {
  const out = [];
  for (const m of html.matchAll(/<figure\b[^>]*>[\s\S]*?<\/figure>/g)) {
    const fig = m[0];
    if (!DEMO_SHOT.test(fig)) continue;
    const cap = /<figcaption>([\s\S]*?)<\/figcaption>/.exec(fig)?.[1] || '';
    if (!/\bdata-demo\b/.test(fig.slice(0, fig.indexOf('>'))) || !TAG.test(cap)) out.push(`demo shot without a "demo data" caption: ${DEMO_SHOT.exec(fig)[0]}`);
  }
  const loose = html.replace(/<figure\b[\s\S]*?<\/figure>/g, '');
  for (const m of loose.matchAll(new RegExp(`<img[^>]+${DEMO_SHOT.source}`, 'g'))) out.push(`demo shot outside a figure: ${m[0].slice(0, 80)}`);
  // each data-demo panel: the tag must appear before the next <section>
  for (const m of html.matchAll(/<div class="stage panelbox"[^>]*\bdata-demo\b/g)) {
    const rest = html.slice(m.index, html.indexOf('</section>', m.index));
    if (!TAG.test(rest)) out.push(`demo panel without a "demo data" caption at ${m.index}`);
  }
  return out;
}

test('site: every demo shot and sample panel has a visible demo data caption', { skip: NO_SITE }, () => {
  const html = siteHtml();
  assert.deepEqual(demoCaptionProblems(html), []);
  assert.ok((html.match(/data-demo/g) || []).length >= 8, 'four demo shots and four sample panels are marked');
});

test('the caption check fails on a demo shot without one', () => {
  const bad = '<figure data-demo class="shot"><img src="assets/img/shot-agents.jpg"><figcaption>The agents table.</figcaption></figure>';
  assert.equal(demoCaptionProblems(bad).length, 1);
  const unmarked = '<figure class="shot"><img src="assets/img/shot-limits-full.jpg"><figcaption><span class="demo">demo data</span> x</figcaption></figure>';
  assert.equal(demoCaptionProblems(unmarked).length, 1);
  const loose = '<p><img src="assets/img/shot-pipe-top.jpg"></p>';
  assert.equal(demoCaptionProblems(loose).length, 1);
  const good = '<figure data-demo class="shot"><img src="assets/img/shot-agents.jpg"><figcaption><span class="demo">demo data</span> x</figcaption></figure>';
  assert.deepEqual(demoCaptionProblems(good), []);
});

test('site: real view section, install link, clip slot and send-to-agent copy', { skip: NO_SITE }, () => {
  const html = siteHtml();
  assert.match(html, /<section id="yours"/);
  assert.match(html, /What it looks like for you/);
  assert.match(html, /href="(?:index\.html)?#download">Try it on your data in 2 minutes</);
  assert.match(html, /data-video="assets\/real-setup\.mp4"/);
  assert.match(html, /shot-real-small\.jpg/);
  assert.match(html, /send it back to your agent in one click \(copy still works anywhere\)/);
  assert.doesNotMatch(html, /copy it back to your agent/);
  for (const f of ['assets/real-setup.mp4', 'assets/img/shot-real-small.jpg', 'assets/img/real-setup-poster.jpg'])
    assert.ok(fs.existsSync(path.join(SITE_DIR, f)), f);
});
