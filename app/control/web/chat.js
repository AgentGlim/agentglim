// Chat tab: transcript bubbles built with textContent only. Code fences become <pre> text; URLs are shown as
// plain text with a copy button (never a link, never auto-opened). Transcripts are hostile input: nothing in
// them is ever parsed as HTML or acted on.
const URL_RE = /\b(?:https?|ftp|javascript|data|file|vbscript):[^\s<>"'`)\]]+/gi;

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function copyButton(value) {
  const b = el('button', 'copy', 'copy');
  b.type = 'button';
  b.setAttribute('aria-label', 'Copy link text');
  b.addEventListener('click', () => { navigator.clipboard?.writeText(value).then(() => { b.textContent = 'copied'; setTimeout(() => { b.textContent = 'copy'; }, 1200); }, () => {}); });
  return b;
}

// plain text with URLs as inert text + copy buttons
export function appendText(parent, text) {
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    parent.appendChild(el('span', 'link', m[0]));
    parent.appendChild(copyButton(m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

// text with ``` fences -> text nodes and <pre> blocks
export function appendRich(parent, text) {
  const parts = String(text ?? '').split(/```[^\n`]*\n?/);
  parts.forEach((p, i) => {
    if (!p) return;
    if (i % 2 === 1) { const pre = el('pre', null, p.replace(/\n$/, '')); parent.appendChild(pre); }
    else appendText(parent, p);
  });
}

export function bubble(b) {
  const d = el('div', `bubble ${['user', 'assistant', 'tool', 'system'].includes(b.role) ? b.role : 'system'}`);
  d.dataset.id = String(b.id);
  if (b.role === 'tool' && b.tool) {
    const det = el('details');
    const sum = el('summary', null, `${b.tool.name}${b.tool.summary ? ` · ${b.tool.summary}` : ''}`);
    det.appendChild(sum);
    if (b.text) det.appendChild(el('pre', null, b.text));
    d.appendChild(det);
    return d;
  }
  d.appendChild(el('span', 'who', b.role === 'assistant' && b.model ? `assistant · ${b.model}` : b.role));
  appendRich(d, b.text || '');
  return d;
}

export function makeChat(container) {
  let cursor = 0, id = null;
  return {
    reset(newId) { id = newId; cursor = 0; container.replaceChildren(); },
    get id() { return id; },
    get cursor() { return cursor; },
    add(list, newCursor) {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
      for (const b of list) container.appendChild(bubble(b));
      while (container.childElementCount > 400) container.firstElementChild.remove();
      if (newCursor != null) cursor = newCursor;
      if (atBottom || list.length) container.scrollTop = container.scrollHeight;
    },
  };
}
