// Loaded synchronously in <head>: apply the cached choice before the first paint.
(() => {
  const key = 'agentglim.theme';
  const root = document.documentElement;
  const valid = (value) => value === 'light' || value === 'dark';
  let revision = 0, saving = 0, writes = Promise.resolve(), unsaved = null;

  const status = () => document.getElementById('themeStatus');

  function label(button, theme) {
    const text = `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`;
    button.setAttribute('aria-label', text);
    button.title = text;
    button.dataset.themeTarget = theme === 'light' ? 'dark' : 'light';
  }

  function apply(theme) {
    root.dataset.theme = valid(theme) ? theme : 'dark';
    try { localStorage.setItem(key, root.dataset.theme); } catch {}
    const button = document.getElementById('themeToggle');
    if (button) label(button, root.dataset.theme);
  }

  try { apply(localStorage.getItem(key)); } catch { apply(null); }

  // Serialize rapid clicks so an older PUT cannot overwrite the latest choice.
  // A failed PUT is remembered and retried, so the server can never snap the page back
  // to its old value (for example when a proxy blocks the write).
  function queueSave(theme) {
    saving++;
    writes = writes.then(async () => {
      try {
        const response = await fetch('/api/prefs', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme }),
        });
        if (!response.ok) throw new Error('save failed');
        if (root.dataset.theme === theme) unsaved = null;
        const el = status(); if (el) el.textContent = '';
      } catch {
        if (root.dataset.theme === theme) unsaved = theme;
        const el = status();
        if (el) el.textContent = 'Theme saved in this browser. Server save failed; it will retry.';
      } finally { saving--; }
    });
  }

  async function refresh() {
    if (saving) return;
    // Never let the old server value overwrite a choice the server has not accepted yet.
    if (unsaved) { queueSave(unsaved); return; }
    const started = revision;
    try {
      const response = await fetch('/api/prefs', { cache: 'no-store' });
      if (!response.ok) return;
      const prefs = await response.json();
      if (started === revision && !saving && !unsaved && valid(prefs.theme)) apply(prefs.theme);
    } catch { /* The cache still works while the server is unavailable. */ }
  }

  const initial = refresh();
  document.addEventListener('DOMContentLoaded', () => {
    apply(root.dataset.theme);
    const button = document.getElementById('themeToggle');
    if (button) button.addEventListener('click', () => {
      const theme = root.dataset.theme === 'light' ? 'dark' : 'light';
      revision++;
      apply(theme);
      queueSave(theme);
    });
    initial.finally(() => { root.dataset.themeReady = 'true'; });
  });
  window.addEventListener('storage', (event) => {
    if (event.key === key && valid(event.newValue)) { revision++; apply(event.newValue); }
  });
  window.addEventListener('focus', refresh);
  window.addEventListener('pageshow', (event) => { if (event.persisted) refresh(); });
})();
