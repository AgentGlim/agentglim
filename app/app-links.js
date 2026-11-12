// Shared by every served page. In the Agentglim app window (?app=1, or remembered for the session) links that open a
// new tab go to the default browser via /api/open-url instead of inside the --app window.
(() => {
  let app = /[?&]app=1\b/.test(location.search);
  try { if (app) sessionStorage.setItem('agApp', '1'); else app = sessionStorage.getItem('agApp') === '1'; } catch {}
  if (!app) return;
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]'); if (!a || e.defaultPrevented || e.button !== 0) return;
    const u = new URL(a.href, location.href); if (!/^https?:$/.test(u.protocol) || (a.target !== '_blank' && u.origin === location.origin)) return;
    e.preventDefault();
    fetch('/api/open-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: u.href }) }).then((r) => { if (!r.ok) throw 0; }).catch(() => window.open(u.href, '_blank'));
  }, true);
})();
