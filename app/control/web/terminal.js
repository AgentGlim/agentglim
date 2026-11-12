// Terminal tab: mirrors the tmux pane over SSE (capture-pane frames, 1 s) and draws them with the built-in ANSI
// renderer, or with xterm.js once the watcher has vendored it into /control/vendor/xterm/ (DEFERRED F01-3).
// Typed keys (printable, Enter, Backspace, arrows, Esc, Ctrl-C) go to POST /api/control/pane/<id>/keys, which
// has the same liveSend guard as every send.
import { renderAnsi } from './ansi.js';

const KEYMAP = { Enter: 'Enter', Backspace: 'BSpace', Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Delete: 'DC' };

let xtermState = null; // null = unknown, false = absent, {Terminal, FitAddon} = loaded
async function loadXterm() {
  if (xtermState !== null) return xtermState;
  xtermState = false;
  try {
    const c = await (await fetch('/api/control/config')).json(); // xterm: true only once web/vendor/xterm/ exists
    if (!c.xterm) return xtermState;
    await new Promise((ok, fail) => { const s = document.createElement('script'); s.src = '/control/vendor/xterm/xterm.js'; s.onload = ok; s.onerror = fail; document.head.appendChild(s); });
    await new Promise((ok) => { const s = document.createElement('script'); s.src = '/control/vendor/xterm/addon-fit.js'; s.onload = ok; s.onerror = ok; document.head.appendChild(s); });
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/control/vendor/xterm/xterm.css'; document.head.appendChild(l);
    if (globalThis.Terminal) xtermState = { Terminal: globalThis.Terminal, FitAddon: globalThis.FitAddon?.FitAddon };
  } catch { xtermState = false; }
  return xtermState;
}

export function makeTerminal({ pre, keycap, onError, post }) {
  let es = null, id = null, xt = null, queue = [], timer = null;
  function draw(text) {
    if (xt) { xt.reset(); xt.write(text.replace(/\n/g, '\r\n')); return; }
    pre.replaceChildren(renderAnsi(text.replace(/\s+$/, '')));
    pre.scrollTop = pre.scrollHeight;
  }
  function flush() {
    timer = null;
    if (!queue.length || !id) return;
    const keys = queue.splice(0, 64);
    post(`/api/control/pane/${encodeURIComponent(id)}/keys`, { keys }).catch(onError);
  }
  function push(k) { queue.push(k); if (!timer) timer = setTimeout(flush, 60); }
  keycap.addEventListener('keydown', (e) => {
    if (!id || e.key === 'Tab' || e.metaKey || e.altKey) return; // Tab leaves the key capture (no keyboard trap)
    if (e.ctrlKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); return push({ key: 'C-c' }); }
    if (e.ctrlKey) return;
    if (KEYMAP[e.key]) { e.preventDefault(); return push({ key: KEYMAP[e.key] }); }
    if (e.key.length === 1) { e.preventDefault(); const last = queue.at(-1); if (last?.text != null && last.text.length < 64) last.text += e.key; else push({ text: e.key }); }
  });
  keycap.addEventListener('paste', (e) => { e.preventDefault(); const t = e.clipboardData?.getData('text') || ''; for (let i = 0; i < t.length && i < 2048; i += 64) push({ text: t.slice(i, i + 64).replace(/[\x00-\x1f\x7f]/g, ' ') }); });
  return {
    async open(newId) {
      this.close(); id = newId;
      const X = await loadXterm();
      if (X && !xt) { pre.replaceChildren(); xt = new X.Terminal({ convertEol: false, disableStdin: true, scrollback: 400 }); xt.open(pre); if (X.FitAddon) { const f = new X.FitAddon(); xt.loadAddon(f); try { f.fit(); } catch {} } }
      es = new EventSource(`/api/control/pane/${encodeURIComponent(id)}/stream`);
      es.addEventListener('frame', (ev) => { try { draw(JSON.parse(ev.data).text); } catch {} });
      es.addEventListener('gone', () => { onError(new Error('pane changed or closed')); this.close(); });
      es.onerror = () => {};
    },
    close() { if (es) es.close(); es = null; queue = []; },
    get id() { return id; },
  };
}
