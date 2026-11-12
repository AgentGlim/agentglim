#!/usr/bin/env node
// Retrofit scroll progress bar, fast SVG scroll motion (incl. no blurred sticky headers) and a "Plan home" back button into existing HTML pages.
// Usage: node scroll-perf.mjs [--home ../index.html] [--no-back] FILE.html...
//   --home  link target of the back button (relative to each file); default: the nearest index.html above the file
// Idempotent: re-running replaces the earlier injection. ASCII only. Also importable: inject(html, {home}).
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const CSS = `<style id="scroll-perf">
.sp-prog{position:fixed;left:0;top:0;height:2px;width:100%;background:var(--purple,var(--accent,#f0a63c));transform-origin:left;transform:scaleX(0);z-index:9999;pointer-events:none}
.sp-prog.sp-in{position:absolute;top:auto;bottom:0;z-index:2}
a.sp-back.sp-back{display:inline-flex;align-items:center;gap:.35em;padding:.3em .85em;border:1px solid var(--line,rgba(127,127,127,.4));border-radius:999px;background:var(--panel,transparent);color:inherit;text-decoration:none;font-size:.88em;line-height:1.4;white-space:nowrap;margin-right:.6em}
a.sp-back.sp-back:hover,a.sp-back.sp-back:focus-visible{border-color:var(--purple,currentColor)}
.sp-backbar{margin:12px 0 6px}
@media(max-width:640px){header a.sp-back.sp-back{padding:.25em .6em;margin-right:.4em}header a.sp-back .sp-t{display:none}header :has(> a.sp-back),header :has(> * > a.sp-back){flex-wrap:wrap;min-width:0}}
svg *{transition-delay:0s!important;animation-delay:0s!important}
@media print{.sp-prog,.sp-backbar,a.sp-back{display:none!important}}
@media(prefers-reduced-motion:reduce){.sp-prog{display:none}}
</style>`;

// bar modes: own = add a bar, adopt = drive the page's undriven #prog, none = page already drives one
const JS = (mode) => `<script id="scroll-perf-js" data-bar="${mode}">/* scroll-perf: progress bar, short SVG transitions, offscreen loops paused */
(function(){var d=document,R=d.documentElement,mode=${JSON.stringify(mode)};
var e0=d.getElementById('prog');if(mode!=='own'&&!(e0&&e0.closest('header')))mode=mode==='none'&&e0?'own':mode==='adopt'?'own':mode;/* only a header bar counts; side-rail progress keeps its own */
if(mode!=='none'){var p=mode==='adopt'?e0:null;
 if(!p){p=d.createElement('div');p.className='sp-prog';p.setAttribute('aria-hidden','true');var h=null;
  d.querySelectorAll('header').forEach(function(x){if(h||x.closest('.hb'))return;var c=getComputedStyle(x);if((c.position==='sticky'||c.position==='fixed')&&parseFloat(c.top||'0')<=10)h=x});
  if(h){p.classList.add('sp-in');h.appendChild(p)}else d.body.appendChild(p)}
 var t=false;function u(){p.style.transform='scaleX('+Math.min(1,R.scrollTop/((R.scrollHeight-R.clientHeight)||1))+')';t=false}
 addEventListener('scroll',function(){if(!t){t=true;requestAnimationFrame(u)}},{passive:true});addEventListener('resize',u);u()}
/* SVG children repaint the whole <svg> every frame they animate: cap transitions at .6s */
function secs(v){return v.split(',').map(function(x){x=x.trim();return x.slice(-2)==='ms'?parseFloat(x)/1000:parseFloat(x)||0})}
d.querySelectorAll('svg *').forEach(function(el){var td=secs(getComputedStyle(el).transitionDuration);
 if(td.some(function(x){return x>.6}))el.style.setProperty('transition-duration',td.map(function(x){return Math.min(x,.6)+'s'}).join(','),'important')});
/* pause infinite animations while their svg (or element) is offscreen */
if(!d.getAnimations||!('IntersectionObserver' in window))return;var seen=new WeakSet();
var io=new IntersectionObserver(function(es){es.forEach(function(e){(e.target._spA||[]).forEach(function(a){try{e.isIntersecting?a.play():a.pause()}catch(_){}})})});
function scan(){d.getAnimations().forEach(function(a){var ef=a.effect,el=ef&&ef.target;if(!el||seen.has(a))return;
 var tm=ef.getTiming&&ef.getTiming();if(!tm||tm.iterations!==Infinity)return;seen.add(a);
 var root=(el.closest&&el.closest('svg'))||el;if(!root._spA){root._spA=[];io.observe(root)}root._spA.push(a)})}
scan();addEventListener('load',function(){setTimeout(scan,1500)})})();
</script>`;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function inject(html, { home = null } = {}) {
  let t = html.replace(/\n?<style id="scroll-perf">[\s\S]*?<\/style>/g, '').replace(/\n?<script id="scroll-perf-js"[\s\S]*?<\/script>/g, '')
    .replace(/<div class="sp-backbar">[\s\S]*?<\/div>\n?/g, '').replace(/<a class="sp-back"[^>]*>[\s\S]*?<\/a>/g, '');
  // known lantern/index chart classes: short SVG child transitions, no stagger, reveal just before view
  t = t.replace(/(\.js \.draw\{[^}\n]*?)transition:stroke-dashoffset [\d.]+s var\(--ease\);transition-delay:calc\(var\(--i,0\) \* \d+ms\)/g, '$1transition:stroke-dashoffset .6s var(--ease)')
    .replace(/(\.js \.gx\{[^}\n]*?)transition:transform [\d.]+s var\(--ease\);transition-delay:calc\(var\(--i,0\) \* \d+ms\)/g, '$1transition:transform .45s var(--ease)')
    .replace(/(\.js \.pop\{[^}\n]*?)transition:opacity [\d.]+s var\(--ease\),transform [\d.]+s var\(--ease\);transition-delay:calc\(var\(--i,0\) \* \d+ms\)/g, '$1transition:opacity .3s var(--ease),transform .45s var(--ease)')
    .replace(/(\.js \.fade\{[^}\n]*?)transition:opacity [\d.]+s ease;transition-delay:calc\(var\(--i,0\) \* \d+ms\)/g, '$1transition:opacity .4s ease')
    .replace("rootMargin:'0px 0px -6% 0px'", "rootMargin:'0px 0px 5% 0px'");
  // backdrop-filter blur re-blurs everything behind a sticky header on every scroll frame: drop it, make the background opaque
  t = t.replace(/\{[^{}<]*backdrop-filter:\s*blur\([^{}<]*\}/g, (r) => r.replace(/(-webkit-)?backdrop-filter:\s*blur\([^)]*\)\s*;?/g, '')
    .replace(/background(-color)?:\s*rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*[\d.]+\s*\)/g, 'background$1:rgb($2,$3,$4)').replace(/;\}$/, '}').replace(/\{;/, '{'));
  const scripts = (t.match(/<script\b[\s\S]*?<\/script>/g) || []).join('\n');
  const hasProg = /id=["']prog["']/.test(t);
  const driven = /(getElementById\(['"]prog['"]\)|\$\(['"]#prog['"]\)|querySelector\(['"]#prog['"]\))/.test(scripts) && /scroll/.test(scripts);
  const mode = hasProg ? (driven ? 'none' : 'adopt') : 'own';
  // pages without </head> or </body> (bare fragments) still get both
  if (/<\/head>/i.test(t)) t = t.replace(/<\/head>/i, `${CSS}\n</head>`);
  else { const s = /<\/style>/i.exec(t), m = /<meta charset[^>]*>/i.exec(t), at = s ? s.index + 8 : m ? m.index + m[0].length : 0; t = t.slice(0, at) + CSS + t.slice(at); }
  if (/<\/body>/i.test(t)) t = t.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${JS(mode)}\n</body>`);
  else if (/<\/html>/i.test(t)) t = t.replace(/<\/html>(?![\s\S]*<\/html>)/i, `${JS(mode)}\n</html>`);
  else t += `\n${JS(mode)}\n`;
  if (home) t = addBack(t, home);
  return t;
}

function addBack(t, home) {
  const norm = (h) => h.replace(/^\.\//, '');
  // already has a button-like link home?
  for (const m of t.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const href = (m[1].match(/href=["']([^"'#?]*)/) || [])[1];
    if (href === undefined || norm(href) !== norm(home)) continue;
    if (/class=["'][^"']*(btn|back|button|pill|chip)/i.test(m[1]) || /(&larr;|\u2190)/.test(m[2])) return t;
  }
  const a = `<a class="sp-back" href="${home}" aria-label="Plan home"><span aria-hidden="true">&larr;</span><span class="sp-t"> Plan home</span></a>`;
  const hb = t.indexOf('<!-- hub-banner:end -->');
  const from = hb >= 0 ? hb : 0;
  const hm = /<header\b[^>]*>/i.exec(t.slice(from));
  if (hm) {
    const hs = from + hm.index, he = t.indexOf('</header>', hs);
    const nm = /<nav\b[^>]*>/i.exec(t.slice(hs, he > 0 ? he : undefined));
    const at = nm ? hs + nm.index + nm[0].length : hs + hm[0].length;
    return t.slice(0, at) + a + t.slice(at);
  }
  const bar = `<div class="sp-backbar">${a}</div>\n`;
  if (hb >= 0) { const at = hb + '<!-- hub-banner:end -->'.length; return t.slice(0, at) + '\n' + bar + t.slice(at).replace(/^\n/, ''); }
  if (/<body\b/i.test(t)) return t.replace(/<body\b[^>]*>/i, (b) => `${b}\n${bar}`);
  const c = t.indexOf('</style>', t.indexOf('<style id="scroll-perf">'));
  return c >= 0 ? t.slice(0, c + 8) + bar + t.slice(c + 8) : bar + t;
}

function findHome(file) {
  let d = dirname(file);
  for (let i = 0; i < 6; i++) {
    const up = dirname(d);
    if (existsSync(join(d, 'index.html')) && resolve(join(d, 'index.html')) !== resolve(file)) return relative(dirname(file), join(d, 'index.html')) || 'index.html';
    if (up === d) break; d = up;
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2); let home = null, back = true; const files = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '--home') home = args[++i]; else if (args[i] === '--no-back') back = false; else files.push(args[i]); }
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const isHome = /^index(-[\w]+)?\.html$/.test(basename(f)) && !/\/(reports|_build|build)\//.test(f);
    const h = back && !isHome ? (home || findHome(f)) : null;
    const out = inject(src, { home: h });
    if (out !== src) writeFileSync(f, out);
    console.log(`${out !== src ? 'updated' : 'same   '} ${f}${h ? ' back->' + h : ''}`);
  }
}
