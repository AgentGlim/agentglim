// update-notice.js: header pill for a newer AgentGlim release. Loaded by the dashboard and /skills.
// It reads /api/version (the server does the GitHub check), links to the release page, offers both update
// commands, and remembers a dismissal per version in localStorage. No auto-install.
(function () {
  'use strict';
  var mount = document.getElementById('updateNotice');
  if (!mount) return;
  var KEY = 'agUpdateDismissed';

  function dismissed(version) {
    try { return localStorage.getItem(KEY) === version; } catch (e) { return false; }
  }
  function remember(version) {
    try { localStorage.setItem(KEY, version); } catch (e) {}
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function copyCommand(code, button) {
    var text = code.textContent || '';
    var done = function () {
      var old = button.textContent;
      button.textContent = 'Copied';
      setTimeout(function () { button.textContent = old; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    } else fallback();
    function fallback() {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      area.remove();
    }
  }
  function command(label, text) {
    var box = el('div', 'ag-update-cmd');
    box.appendChild(el('span', 'ag-update-cmd-label', label));
    var line = el('div', 'ag-update-cmd-line');
    var code = el('code', null, text || '');
    var button = el('button', 'ag-update-copy', 'Copy');
    button.type = 'button';
    button.addEventListener('click', function () { copyCommand(code, button); });
    line.appendChild(code);
    line.appendChild(button);
    box.appendChild(line);
    return box;
  }

  function render(info) {
    if (!info || !info.updateAvailable || !info.latest) return;
    if (info.current === 'dev') return;
    if (dismissed(info.latest)) return;

    var root = el('div', 'ag-update');
    root.setAttribute('role', 'status');
    var link = el('a', 'ag-update-link');
    link.href = info.url || 'https://github.com/AgentGlim/agentglim/releases';
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Update available: ' + info.latest + ' \u2192 see what\'s new';
    root.appendChild(link);

    var how = el('details', 'ag-update-how');
    how.appendChild(el('summary', null, 'How to update'));
    var body = el('div', 'ag-update-body');
    body.appendChild(command('In your clone:', (info.howTo && info.howTo.git) || 'npm run update'));
    body.appendChild(el('p', 'ag-update-note', (info.howTo && info.howTo.restart) || 'Restart AgentGlim after updating.'));
    how.appendChild(body);
    root.appendChild(how);

    var close = el('button', 'ag-update-x', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss update notice');
    close.title = 'Dismiss until the next version';
    close.addEventListener('click', function () {
      remember(info.latest);
      root.remove();
    });
    root.appendChild(close);
    mount.appendChild(root);
  }

  function load(attempt) {
    attempt = attempt || 0;
    fetch('/api/version', { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (info) {
      render(info);
      // First load can race the background check; retry briefly while it has never succeeded.
      if (!info.checkedAt && info.enabled && info.current !== 'dev' && attempt < 3) {
        setTimeout(function () { load(attempt + 1); }, 4000);
      }
    }).catch(function () {});
  }
  load(0);
})();
