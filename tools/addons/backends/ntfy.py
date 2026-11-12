"""Phone push through ntfy (https://ntfy.sh or a self-hosted server). Off until you enable it.

To turn it on, in ~/.config/agent-notify/config.toml:
    extra_backends = ["ntfy"]
    [ntfy]
    enabled = true
    topic = "<long random string; anyone who knows it can read your pings>"
Then install the ntfy app and subscribe to the same topic.
By default only the event and project name leave this machine (include_text = false).
"""
import urllib.request

NAME = 'ntfy'
PRIORITY = {'high': '4', 'normal': '3', 'low': '2'}


def available(cfg):
    c = cfg.get('ntfy', {})
    if not c.get('enabled'):
        return False, 'disabled in config ([ntfy] enabled = false)'
    if len(c.get('topic', '')) < 12:
        return False, 'set a long, random [ntfy] topic first'
    return True, ''


def build_request(n, cfg):
    c = cfg['ntfy']
    body = n.short(300) if c.get('include_text') else f'{n.label} in {n.project or n.agent}'
    req = urllib.request.Request(f"{c['server'].rstrip('/')}/{c['topic']}", data=body.encode('utf-8'), method='POST')
    req.add_header('Title', n.heading().encode('ascii', 'replace').decode())
    req.add_header('Priority', PRIORITY.get(n.urgency, '3'))
    req.add_header('Tags', n.event)
    if c.get('token'):
        req.add_header('Authorization', f"Bearer {c['token']}")
    return req


def send(n, cfg):
    with urllib.request.urlopen(build_request(n, cfg), timeout=8) as r:
        if r.status >= 300:
            raise RuntimeError(f'HTTP {r.status}')
