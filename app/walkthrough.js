// Agentglim first-run tour (feature "walkthrough", 2026-11-06).
// Steps live in /walkthrough-steps.json, keyed by CSS selectors. Missing or hidden targets are skipped.
// Starts from the "?" button (#tourBtn), and once by itself on a browser's first visit.
(() => {
  const SEEN = 'agTourSeen';
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let steps = null, list = [], i = 0, ui = null, lastFocus = null, raf = 0, starting = false;

  const load = async () => {
    if (steps) return steps;
    try { steps = (await (await fetch('/walkthrough-steps.json', { cache: 'no-cache' })).json()).steps || []; }
    catch { steps = []; }
    return steps;
  };
  const visible = (el) => {
    if (!el || el.closest('[hidden]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  };
  const target = (s) => { try { return document.querySelector(s.target); } catch { return null; } };

  function build() {
    const spot = document.createElement('div'); spot.className = 'wt-spot';
    const tip = document.createElement('div'); tip.className = 'wt-tip';
    tip.setAttribute('role', 'dialog'); tip.setAttribute('aria-modal', 'true'); tip.setAttribute('aria-labelledby', 'wtTitle');
    tip.innerHTML = '<h3 id="wtTitle"></h3><p id="wtBody"></p><div class="wt-row"><span class="wt-count" aria-live="polite"></span>'
      + '<button type="button" class="wt-skip">Skip</button><button type="button" class="wt-back">Back</button><button type="button" class="wt-next">Next</button></div>';
    tip.querySelector('.wt-skip').onclick = () => end();
    tip.querySelector('.wt-back').onclick = () => go(i - 1);
    tip.querySelector('.wt-next').onclick = () => go(i + 1);
    document.body.append(spot, tip);
    return { spot, tip };
  }

  function place() {
    if (!ui) return;
    const el = target(list[i]);
    if (!visible(el)) { ui.spot.style.display = 'none'; centerTip(); return; }
    const vw = document.documentElement.clientWidth, vh = innerHeight, pad = 6, r = el.getBoundingClientRect();
    const top = Math.max(r.top - pad, 4), left = Math.max(r.left - pad, 4);
    const bottom = Math.min(r.bottom + pad, vh - 4), right = Math.min(r.right + pad, vw - 4);
    Object.assign(ui.spot.style, { display: '', top: top + 'px', left: left + 'px', width: Math.max(right - left, 0) + 'px', height: Math.max(bottom - top, 0) + 'px' });
    const t = ui.tip, th = t.offsetHeight, tw = t.offsetWidth, gap = 12;
    let y;
    if (bottom + gap + th <= vh - 8) y = bottom + gap;
    else if (top - gap - th >= 8) y = top - gap - th;
    else y = vh - th - 12; // target fills the screen: dock the tooltip at the bottom
    const x = Math.min(Math.max(left, 16), vw - tw - 16);
    t.style.top = Math.max(y, 8) + 'px'; t.style.left = Math.max(x, 16) + 'px';
  }
  function centerTip() {
    const t = ui.tip; t.style.top = Math.max((innerHeight - t.offsetHeight) / 2, 8) + 'px';
    t.style.left = Math.max((document.documentElement.clientWidth - t.offsetWidth) / 2, 16) + 'px';
  }
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };

  function go(n) {
    if (!ui) return;
    if (n >= list.length) return end();
    if (n < 0) return;
    // skip steps whose target vanished since the tour started (live data re-renders the page)
    const dir = n >= i ? 1 : -1;
    while (n >= 0 && n < list.length && !visible(target(list[n]))) n += dir;
    if (n >= list.length) return end();
    if (n < 0) return;
    i = n;
    const s = list[i], el = target(s);
    ui.tip.querySelector('#wtTitle').textContent = s.title;
    ui.tip.querySelector('#wtBody').textContent = s.body;
    ui.tip.querySelector('.wt-count').textContent = `${i + 1} of ${list.length}`;
    ui.tip.querySelector('.wt-back').disabled = i === 0;
    ui.tip.querySelector('.wt-next').textContent = i === list.length - 1 ? 'Done' : 'Next';
    const tall = el.getBoundingClientRect().height > innerHeight * 0.6;
    el.scrollIntoView({ block: tall ? 'start' : 'center', inline: 'nearest', behavior: reduce() ? 'instant' : 'smooth' });
    place(); setTimeout(place, reduce() ? 0 : 350);
    ui.tip.querySelector('.wt-next').focus({ preventScroll: true });
  }

  function onKey(e) {
    if (!ui) return;
    if (e.key === 'Escape') { e.preventDefault(); end(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'Tab') { // keep focus inside the tooltip
      const b = [...ui.tip.querySelectorAll('button:not([disabled])')], k = b.indexOf(document.activeElement);
      e.preventDefault(); b[(k + (e.shiftKey ? -1 : 1) + b.length) % b.length].focus();
    }
  }

  // A click anywhere outside the tooltip closes the tour and still does what it was meant to do
  // (open a link, press a button). The tour never blocks the page.
  const onOutside = (e) => { if (ui && !ui.tip.contains(e.target) && e.target.id !== 'tourBtn') end(); };

  async function start() {
    if (ui || starting) return; // one tour at a time: a second start (auto-start racing the ? button) would orphan layers
    starting = true;
    try { await load(); } finally { starting = false; }
    if (ui) return;
    list = steps.filter((s) => visible(target(s)));
    if (!list.length) return;
    lastFocus = document.activeElement;
    ui = build(); i = 0;
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside, true);
    addEventListener('resize', schedule); addEventListener('scroll', schedule, true);
    go(0);
  }
  function end() {
    if (!ui) return;
    try { localStorage.setItem(SEEN, '1'); } catch {}
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    removeEventListener('resize', schedule); removeEventListener('scroll', schedule, true);
    ui = null;
    document.querySelectorAll('.wt-spot, .wt-tip, .wt-shade').forEach((n) => n.remove()); // nothing of the tour may stay behind
    lastFocus?.focus?.({ preventScroll: true });
  }

  window.AgentglimTour = { start, end, next: () => go(i + 1), back: () => go(i - 1), get open() { return !!ui; }, get step() { return ui ? list[i]?.id : null; }, get count() { return list.length; } };

  const wire = () => {
    document.getElementById('tourBtn')?.addEventListener('click', (e) => { e.preventDefault(); start(); });
    let seen = '1'; try { seen = localStorage.getItem(SEEN); } catch {}
    if (!seen && !/[?&]notour\b/.test(location.search)) setTimeout(start, 2500); // first visit: wait for live data to render
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
