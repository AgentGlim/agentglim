// Settings (#/settings): notifications for this phone. Notification.requestPermission() runs only inside the
// "Turn on notifications" tap (the TWA turns it into Android 13+'s POST_NOTIFICATIONS prompt); then the service
// worker subscribes with the server's VAPID key and the subscription is posted. Nine per-type switches (this
// phone's own; the desktop sets the defaults) and "Send a test notification".
const u2a = (s) => { const t = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(t, (c) => c.charCodeAt(0)); };

export async function subscribeFlow({ post, vapidPublicKey }) {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) throw new Error('This browser has no notifications.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked: allow them in Android settings for this app.' : 'Notifications were not allowed.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u2a(vapidPublicKey) });
  const j = typeof sub.toJSON === 'function' ? sub.toJSON() : sub;
  return post('/api/remote/push/subscribe', { subscription: { endpoint: j.endpoint, keys: { p256dh: j.keys?.p256dh, auth: j.keys?.auth } } });
}

export async function render(root, r, { get, post, el, card, toast, appVersion, me }) {
  const c = card('c-settings', 'Notifications'); root.appendChild(c);
  let st = await get('/api/remote/push');
  const status = el('p', 'meta'); c.appendChild(status);
  const btns = el('div', 'btnrow'); c.appendChild(btns);
  const on = el('button', 'btn primary', 'Turn on notifications'); on.type = 'button'; on.id = 'pushOn';
  const test = el('button', 'btn', 'Send a test notification'); test.type = 'button'; test.id = 'pushTest';
  btns.append(on, test);
  const list = el('div'); list.style.marginTop = '10px'; c.appendChild(list);
  function draw() {
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    status.textContent = `This phone: ${st.subscriptions} subscription${st.subscriptions === 1 ? '' : 's'} · permission ${perm}${st.lastTest ? ` · last test ${st.lastTest.status}` : ''}`;
    on.textContent = st.subscriptions ? 'Renew subscription' : 'Turn on notifications';
    test.disabled = !st.subscriptions;
    list.replaceChildren(...st.order.map((t) => {
      const lab = el('label', 'sw'); const s = el('span', 'lbl', st.labels[t] || t);
      const own = t in (st.own || {}); if (!own) s.appendChild(el('span', 'meta', ' (default)'));
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!st.types[t]; cb.dataset.type = t; cb.setAttribute('role', 'switch');
      cb.addEventListener('change', async () => { try { st = await post('/api/remote/push/prefs', { types: { [t]: cb.checked } }); draw(); } catch (e) { toast(e, true); cb.checked = !cb.checked; } });
      lab.append(s, cb); return lab;
    }));
  }
  on.addEventListener('click', async () => {
    try { st = await subscribeFlow({ post, vapidPublicKey: st.vapidPublicKey }); toast('Notifications are on'); } catch (e) { toast(e, true); }
    draw();
  });
  test.addEventListener('click', async () => {
    try { const x = await post('/api/remote/push/test'); toast(x.ok ? 'Test sent' : `Push service said ${x.results.map((y) => y.status).join(', ')}`, !x.ok); st = await get('/api/remote/push'); draw(); } catch (e) { toast(e, true); }
  });
  draw();
  const a = card('c-about', 'This app');
  const v = appVersion();
  a.appendChild(el('p', 'meta', `Device: ${me()?.device?.name || '–'} · app version ${v ?? 'browser'} · unlock lasts 15 min idle`));
  const d = el('a', 'btn', 'Full desktop page'); d.href = '/m/desktop'; a.appendChild(d);
  root.appendChild(a);
}
