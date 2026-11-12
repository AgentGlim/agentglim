/* Service worker for the phone UI (scope "/" on the remote listener). A classic script (no modules) so every
   Chrome and the TWA can run it.
   fetch: caches ONLY the app shell (the /m/ HTML, CSS and JS, the icons, the manifest, the shared /lib/ renderer),
   network first so an update shows at once; /api/*, /app/* and everything else go straight to the network and are
   never stored. A page load that fails offline gets the cached shell, or /m/offline.html.
   push: shows {title, body, tag} with the monochrome badge (renotify for needs_input, so a newer one buzzes again).
   notificationclick: focuses an open /m/ window and navigates it to the payload url, or opens a new one. */
'use strict';
var CACHE = 'obs-shell-v1';
var SHELL = ['/m/', '/m/app.css', '/m/app.js', '/m/offline.html', '/m/tabs/dashboard.js', '/m/tabs/sessions.js', '/m/tabs/watcher.js', '/m/tabs/approvals.js', '/m/tabs/settings.js',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/badge-96.png'];
var OFFLINE = '/m/offline.html';

function isShell(pathname) {
  if (pathname === '/m/' || pathname === '/manifest.webmanifest') return true;
  if (pathname === '/m/desktop' || pathname.indexOf('/api/') === 0 || pathname.indexOf('/app/') === 0) return false;
  return /^\/m\/[\w/.-]+\.(html|css|js)$/.test(pathname) || /^\/icons\/[\w.-]+\.png$/.test(pathname) || /^\/lib\/(chat|ansi)\.js$/.test(pathname);
}
function safeUrl(u) { return typeof u === 'string' && /^\/m\/[\w#/?=&%:.-]*$/.test(u) ? u : '/m/'; }

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).catch(function () {}).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  var path = url.pathname;
  if (isShell(path)) {
    var key = path === '/m/' ? '/m/' : path; // /m/?src=twa&v=3 is the same shell
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === 'basic') { var copy = res.clone(); caches.open(CACHE).then(function (c) { return c.put(key, copy); }); }
      return res;
    }).catch(function () {
      return caches.match(key).then(function (hit) { return hit || (req.mode === 'navigate' ? caches.match(OFFLINE) : Response.error()); });
    }));
    return;
  }
  // not shell: never cached. A failed page load (e.g. /m/desktop off the tailnet) shows the offline page.
  if (req.mode === 'navigate') e.respondWith(fetch(req).catch(function () { return caches.match(OFFLINE).then(function (r) { return r || new Response('Not connected to your tailnet', { status: 503, headers: { 'content-type': 'text/plain' } }); }); }));
});

self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  var title = typeof d.title === 'string' && d.title ? d.title.slice(0, 80) : 'AgentGlim';
  var opts = {
    body: typeof d.body === 'string' ? d.body.slice(0, 240) : '',
    tag: typeof d.tag === 'string' && d.tag ? d.tag.slice(0, 120) : (d.type || 'obs'),
    renotify: d.type === 'needs_input',
    badge: '/icons/badge-96.png',
    icon: '/icons/icon-192.png',
    data: { url: safeUrl(d.url), type: typeof d.type === 'string' ? d.type : null },
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = safeUrl(e.notification.data && e.notification.data.url);
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i], p = '';
      try { p = new URL(c.url).pathname; } catch (err) { p = ''; }
      if (p.indexOf('/m/') === 0 && p !== '/m/desktop') {
        return c.focus().then(function (fc) {
          var w = fc || c;
          if (w.navigate) return w.navigate(url).catch(function () { w.postMessage({ type: 'navigate', url: url }); return w; });
          w.postMessage({ type: 'navigate', url: url }); return w;
        });
      }
    }
    return self.clients.openWindow(url);
  }));
});
