// Built-in ANSI renderer for the Terminal tab. SGR colors (16, 256, truecolor), bold, dim, italic, underline,
// reverse. Everything becomes text nodes inside spans (classes from control.css, 256/truecolor via CSSOM);
// every other escape (cursor moves, OSC titles and links, DCS, private modes) is dropped.
const CSI = /\x1b\[([0-?]*)([ -/]*)([@-~])/y;
const OTHER = [/\x1b\][\s\S]*?(?:\x07|\x1b\\)/y, /\x1bP[\s\S]*?\x1b\\/y, /\x1b[@-Z\\-_]/y, /\x1b./y];
const CUBE = [0, 95, 135, 175, 215, 255];
export function color256(n) {
  if (n < 16) return { cls: n };
  if (n < 232) { n -= 16; return { rgb: [CUBE[Math.floor(n / 36)], CUBE[Math.floor(n / 6) % 6], CUBE[n % 6]] }; }
  const g = 8 + (n - 232) * 10; return { rgb: [g, g, g] };
}
const fresh = () => ({ b: false, d: false, i: false, u: false, rev: false, fg: null, bg: null });

function applySgr(st, params) {
  const p = params === '' ? [0] : params.split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)));
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === 0) Object.assign(st, fresh());
    else if (c === 1) st.b = true; else if (c === 2) st.d = true; else if (c === 3) st.i = true; else if (c === 4) st.u = true; else if (c === 7) st.rev = true;
    else if (c === 22) st.b = st.d = false; else if (c === 23) st.i = false; else if (c === 24) st.u = false; else if (c === 27) st.rev = false;
    else if (c >= 30 && c <= 37) st.fg = { cls: c - 30 }; else if (c === 39) st.fg = null;
    else if (c >= 40 && c <= 47) st.bg = { cls: c - 40 }; else if (c === 49) st.bg = null;
    else if (c >= 90 && c <= 97) st.fg = { cls: c - 90 + 8 }; else if (c >= 100 && c <= 107) st.bg = { cls: c - 100 + 8 };
    else if (c === 38 || c === 48) {
      let col = null;
      if (p[i + 1] === 5 && p[i + 2] != null) { col = color256(Math.max(0, Math.min(255, p[i + 2]))); i += 2; }
      else if (p[i + 1] === 2 && p[i + 4] != null) { col = { rgb: [p[i + 2], p[i + 3], p[i + 4]].map((v) => Math.max(0, Math.min(255, v | 0))) }; i += 4; }
      if (c === 38) st.fg = col; else st.bg = col;
    }
  }
}

// text -> [{text, st}] runs; pure, used by tests
export function parseAnsi(text) {
  const out = []; let st = fresh(), buf = '', i = 0;
  const flush = () => { if (buf) { out.push({ text: buf, st: { ...st } }); buf = ''; } };
  const s = String(text ?? '');
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\x1b') {
      CSI.lastIndex = i; const m = CSI.exec(s);
      if (m) { if (m[3] === 'm' && !m[2]) { flush(); applySgr(st, m[1]); } i = CSI.lastIndex; continue; }
      let hit = false;
      for (const re of OTHER) { re.lastIndex = i; const o = re.exec(s); if (o) { i = re.lastIndex; hit = true; break; } }
      if (!hit) i += 1;
      continue;
    }
    const code = ch.charCodeAt(0);
    if ((code < 32 && ch !== '\n' && ch !== '\t') || code === 127) { i += 1; continue; }
    buf += ch; i += 1;
  }
  flush();
  return out;
}

// runs -> DocumentFragment of spans with text nodes only
export function renderAnsi(text, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  for (const r of parseAnsi(text)) {
    const s = r.st;
    const plain = !s.b && !s.d && !s.i && !s.u && !s.rev && !s.fg && !s.bg;
    if (plain) { frag.appendChild(doc.createTextNode(r.text)); continue; }
    const span = doc.createElement('span');
    const cls = [];
    if (s.b) cls.push('a-b'); if (s.d) cls.push('a-d'); if (s.i) cls.push('a-i'); if (s.u) cls.push('a-u');
    let fg = s.fg, bg = s.bg;
    if (s.rev) { [fg, bg] = [bg || { cls: 0 }, fg || { cls: 7 }]; }
    if (fg?.cls != null) cls.push(`a-f${fg.cls}`); else if (fg?.rgb) span.style.color = `rgb(${fg.rgb.join(',')})`;
    if (bg?.cls != null) cls.push(`a-g${bg.cls}`); else if (bg?.rgb) span.style.backgroundColor = `rgb(${bg.rgb.join(',')})`;
    if (cls.length) span.className = cls.join(' ');
    span.textContent = r.text;
    frag.appendChild(span);
  }
  return frag;
}
