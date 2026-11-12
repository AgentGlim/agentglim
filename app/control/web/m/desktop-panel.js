// Desktop Control page, card "Phone app & notifications" (sub-item 03 A7, A8): the APK link with its sha256 (the
// download itself is served on the remote listener, behind the unlock), the default per-type push switches
// (stored in control.db; each phone can override its own), and a test push to every subscribed phone.
// Loaded by /control as /control/m/desktop-panel.js. textContent only.
const $ = (id) => document.getElementById(id);
async function api(method, p, body) {
  const r = await fetch(p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; }

async function load() {
  if (!$('phoneCard')) return;
  try {
    const a = await api('GET', '/api/control/app');
    if (a.version) {
      $('phApp').textContent = `Observatory ${a.version.versionName} (versionCode ${a.version.versionCode}), ${Math.round(a.version.size / 1024)} KB, built ${a.version.builtAt || '–'}. Install it on the phone from the tailnet address below; check the sha256.`;
      const link = $('phApk');
      link.href = a.remoteOrigin ? `${a.remoteOrigin}${a.apk}` : a.apk; link.hidden = false;
      $('phSha').textContent = `sha256 ${a.version.sha256}`; $('phSha').hidden = false;
    }
    const p = await api('GET', '/api/control/push');
    $('phStatus').textContent = `${p.subscriptions} phone subscription${p.subscriptions === 1 ? '' : 's'}${p.lastTest ? ` · last test ${p.lastTest.status}` : ''}`;
    const box = $('phTypes'); box.replaceChildren();
    for (const t of p.order) {
      const lab = el('label', 'switch');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!p.defaults[t]; cb.setAttribute('role', 'switch'); cb.dataset.type = t;
      const tr = el('span', 'track'); tr.setAttribute('aria-hidden', 'true');
      lab.append(cb, tr, el('span', null, p.labels[t] || t));
      cb.addEventListener('change', async () => { try { await api('POST', '/api/control/push/defaults', { types: { [t]: cb.checked } }); $('phMsg').textContent = 'default saved'; } catch (e) { cb.checked = !cb.checked; $('phMsg').textContent = e.message; } });
      box.appendChild(lab);
    }
  } catch (e) { $('phMsg').textContent = e.message; }
}
$('phTest')?.addEventListener('click', async () => {
  try { const x = await api('POST', '/api/control/push/test', {}); $('phMsg').textContent = `push service said ${x.results.map((r) => r.status).join(', ')}`; } catch (e) { $('phMsg').textContent = e.message; }
  load();
});
load();
