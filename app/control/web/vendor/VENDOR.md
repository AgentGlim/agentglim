# Vendored browser code (optional upgrade, DEFERRED F01-3)

The Terminal tab works without anything here (built-in `web/ansi.js`). Once the watcher vendors xterm.js, `/control`
uses it automatically (`GET /api/control/config` reports `xterm: true` when `vendor/xterm/xterm.js` exists).

Exact steps (needs the network, so the watcher or the owner runs them; builders may not download):

```bash
cd /tmp && mkdir -p xterm-vendor && cd xterm-vendor
npm pack @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0
sha256sum xterm-xterm-6.0.0.tgz xterm-addon-fit-0.11.0.tgz   # record both lines below before copying
tar xzf xterm-xterm-6.0.0.tgz && mkdir -p x && mv package x/xterm && tar xzf xterm-addon-fit-0.11.0.tgz && mv package x/fit
D="$(git rev-parse --show-toplevel)/app/control/web/vendor/xterm"
mkdir -p $D && cp x/xterm/lib/xterm.js x/xterm/css/xterm.css x/xterm/LICENSE $D/ && cp x/fit/lib/addon-fit.js $D/addon-fit.js
```

sha256 (fill in when vendored; the registry tarballs are content-addressed, compare with `npm view @xterm/xterm@6.0.0 dist.integrity`):

```
<sha256>  xterm-xterm-6.0.0.tgz
<sha256>  xterm-addon-fit-0.11.0.tgz
```

License: MIT (both). Both files are served same-origin, so the page CSP (`script-src 'self'`) allows them.
