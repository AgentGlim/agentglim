// shortcuts.js: shared keyboard shortcuts for every served page. Loaded with `defer` by the
// dashboard, the Goals app and the Skill Editor (server.mjs injects it into /skills if needed).
//
// Goals: 1-4 tabs, a asks, j/k asks entries, r refresh, p print, ? help, Esc close.
// Skill Editor: / search, s save, j/k next/previous skill.
// Main app: g goals, s skill editor, h harness, j/k next/previous section, 1-9 a section, ? tour.
// Shortcuts never fire while typing in an input, textarea, select or contenteditable element,
// and never with Ctrl, Alt or Meta held.
(() => {
  const isTyping = (el) => !!el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName || ''));
  const click = (selector) => { const el = document.querySelector(selector); if (el && !el.disabled) { el.click(); return true; } return false; };
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const page = () => document.body?.dataset?.page
    || (location.pathname.startsWith('/skills') ? 'skills' : location.pathname === '/' || location.pathname === '/index.html' ? 'main' : 'other');

  function goals(event, key) {
    const menu = document.getElementById('asksMenu');
    const tabs = { 1: '#overview', 2: null, 3: '#week', 4: '#rules' };
    if (tabs[key] !== undefined) {
      if (key === '2') { if (menu) menu.open = true; return true; }
      if (menu) menu.open = false;
      location.hash = tabs[key];
      return true;
    }
    if (key === 'a') {
      if (!menu) return false;
      menu.open = true;
      menu.querySelector('a')?.focus();
      return true;
    }
    if (key === 'j' || key === 'k') {
      const links = [...document.querySelectorAll('#asksMenuList a')].filter(visible);
      if (!links.length) return false;
      const at = links.indexOf(document.activeElement);
      const next = key === 'j' ? (at + 1) % links.length : (at <= 0 ? links.length - 1 : at - 1);
      links[next].focus();
      return true;
    }
    if (key === 'r') return click('#refreshBtn');
    if (key === 'p') return click('#printBtn');
    if (key === '?') return click('#helpBtn');
    if (key === 'Escape' && menu) { menu.open = false; return true; }
    return false;
  }

  function skills(event, key) {
    if (key === '/') {
      const q = document.getElementById('q');
      if (q) { event.preventDefault(); q.focus(); q.select?.(); return true; }
      return false;
    }
    if (key === 's') return click('[data-act=save]');
    if (key === 'j' || key === 'k') {
      const nodes = [...document.querySelectorAll('[data-id]')].filter(visible);
      if (!nodes.length) return false;
      const at = nodes.indexOf(document.activeElement);
      const next = key === 'j' ? (at + 1) % nodes.length : (at <= 0 ? nodes.length - 1 : at - 1);
      nodes[next].focus();
      nodes[next].click();
      return true;
    }
    return false;
  }

  function main(event, key) {
    if (key === 'g') { location.href = '/goals'; return true; }
    if (key === 's') { location.href = '/skills'; return true; }
    if (key === 'h') { location.href = '/harness'; return true; }
    if (key === '?') return click('#tourBtn');
    if (key === 'j' || key === 'k' || /^[1-9]$/.test(key)) {
      const sections = [...document.querySelectorAll('main > section, main > .card')].filter(visible);
      if (!sections.length) return false;
      if (/^[1-9]$/.test(key)) {
        const target = sections[Number(key) - 1];
        if (!target) return false;
        target.scrollIntoView({ behavior: 'instant', block: 'start' });
        return true;
      }
      const at = sections.findIndex((s) => s.getBoundingClientRect().top >= -8);
      const step = key === 'j' ? 1 : -1;
      const next = Math.max(0, Math.min(sections.length - 1, (at < 0 ? 0 : at) + step));
      sections[next].scrollIntoView({ behavior: 'instant', block: 'start' });
      return true;
    }
    return false;
  }

  addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTyping(event.target)) return;
    const key = event.key;
    const name = page();
    const handled = name === 'goals' ? goals(event, key)
      : name === 'skills' ? skills(event, key)
      : name === 'main' ? main(event, key) : false;
    if (handled) event.preventDefault();
  });

  // Exposed for tests and for the Skill Editor's own help text.
  window.AgentGlimShortcuts = { page, isTyping };
})();
