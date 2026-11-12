"""Core of agent-notify: the Notification shape, config, routing, dedupe and logging.

Backends live in backends/<name>.py. Each exposes:
    NAME = "<name>"
    def available(cfg) -> tuple[bool, str]   # (usable here?, reason if not)
    def send(n: Notification, cfg) -> None   # raise on failure
"""
import platform, tempfile
import dataclasses, importlib, json, os, subprocess, time, tomllib
from pathlib import Path

EVENTS = {
    # event: (label shown to you, urgency used by backends)
    'needs_input': ('Needs your input', 'high'),
    'blocked': ('Blocked', 'high'),
    'finished': ('Finished', 'normal'),
    'working': ('Working now', 'low'),
    'info': ('Update', 'normal'),
}

DEFAULTS = {
    'events': ['needs_input', 'blocked', 'finished', 'working'],
    'finished_min_minutes': 5,
    'dedupe_seconds': 60,
    'desktop': 'auto',          # auto | windows | linux | off
    'extra_backends': [],       # e.g. ["ntfy"] once a phone backend is set up
    'windows': {'agent_logos': True},  # each agent's own name + logo in place of "Windows PowerShell"
    # Logo shown inside each agent's pings (files in icons/). Pi runs local Qwen models here.
    'logos': {'Claude Code': 'claude', 'Codex': 'codex', 'Pi': 'qwen'},
    'ntfy': {'enabled': False, 'server': 'https://ntfy.sh', 'topic': '', 'token': '', 'include_text': False},
}

def tmux_pane_title():
    """Title of the tmux pane this agent runs in ($TMUX_PANE), or '' outside tmux."""
    pane = os.environ.get('TMUX_PANE')
    if not pane:
        return ''
    try:
        t = subprocess.run(['tmux', 'display-message', '-p', '-t', pane, '#{pane_title}'],
                           capture_output=True, text=True, timeout=1).stdout.strip()
    except Exception:
        return ''
    # default titles (host name, shell) say nothing
    return '' if not t or t in ('bash', 'zsh', 'sh', platform.node()) else t


CONFIG_PATH = Path(os.environ.get('AGENT_NOTIFY_CONFIG',
                                  Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config')) / 'agent-notify' / 'config.toml'))


@dataclasses.dataclass
class Notification:
    event: str
    message: str
    agent: str = 'agent'
    project: str = ''
    title: str = ''
    pane: str = dataclasses.field(default_factory=tmux_pane_title)

    @property
    def label(self):
        return EVENTS.get(self.event, EVENTS['info'])[0]

    @property
    def urgency(self):
        return EVENTS.get(self.event, EVENTS['info'])[1]

    def heading(self):
        where = self.project or self.agent
        if self.pane and self.pane != where:
            where = f'{where} (tmux {self.pane})'
        return self.title or f'{self.label}: {where}'

    def short(self, n=180):
        m = ' '.join(self.message.split())
        return m if len(m) <= n else m[:n - 3] + '...'


def load_config(path=None):
    cfg = json.loads(json.dumps(DEFAULTS))
    p = Path(path) if path else CONFIG_PATH
    if p.exists():
        with open(p, 'rb') as f:
            user = tomllib.load(f)
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    return cfg


def state_dir():
    for d in (Path(os.environ.get('XDG_STATE_HOME', Path.home() / '.local' / 'state')) / 'agent-notify',
              Path(tempfile.gettempdir()) / ('agent-notify-' + str(getattr(os, 'getuid', lambda: 'user')()))):
        try:
            d.mkdir(parents=True, exist_ok=True)
            probe = d / '.w'
            probe.write_text('')
            probe.unlink()
            return d
        except OSError:
            continue
    return None


def is_wsl():
    if os.environ.get('WSL_DISTRO_NAME'):
        return True
    try:
        return 'microsoft' in Path('/proc/version').read_text().lower()
    except OSError:
        return False


def desktop_backend(cfg):
    choice = cfg.get('desktop', 'auto')
    if choice == 'off':
        return None
    if choice != 'auto':
        return choice
    return 'windows' if is_wsl() or os.name == 'nt' else 'macos' if platform.system() == 'Darwin' else 'linux'


def backend_names(cfg):
    names = [b for b in [desktop_backend(cfg)] if b]
    for extra in cfg.get('extra_backends', []):
        if extra not in names:
            names.append(extra)
    return names


def load_backend(name):
    return importlib.import_module(f'backends.{name}')


def _log(sd, rec):
    if sd is None:
        return
    try:
        with open(sd / 'log.jsonl', 'a') as f:
            f.write(json.dumps(rec) + '\n')
    except OSError:
        pass


def should_send(n, cfg, sd, now=None):
    """Return (send?, reason). Applies the event filter and the dedupe window."""
    now = now or time.time()
    if n.event not in cfg['events'] and n.event != 'info':
        return False, f'event {n.event} not enabled'
    if sd is None:
        return True, 'no state dir; dedupe skipped'
    path = sd / 'recent.json'
    try:
        recent = json.loads(path.read_text())
    except (OSError, ValueError):
        recent = {}
    win = cfg['dedupe_seconds']
    key = f'{n.event}|{n.project}'
    if now - recent.get(key, 0) < win:
        return False, 'duplicate within dedupe window'
    if n.event == 'finished':
        # a question or a blocker was just sent for this project; "finished" adds nothing
        for ev in ('needs_input', 'blocked'):
            if now - recent.get(f'{ev}|{n.project}', 0) < win:
                return False, f'{ev} sent moments ago'
    recent = {k: t for k, t in recent.items() if now - t < 3600}
    recent[key] = now
    try:
        path.write_text(json.dumps(recent))
    except OSError:
        pass
    return True, 'ok'


def deliver(n, cfg):
    """Send n to every configured backend. Returns {backend: 'ok' | error}."""
    sd = state_dir()
    ok, why = should_send(n, cfg, sd)
    results = {}
    if ok:
        for name in backend_names(cfg):
            try:
                b = load_backend(name)
                usable, reason = b.available(cfg)
                if not usable:
                    results[name] = f'unavailable: {reason}'
                    continue
                b.send(n, cfg)
                results[name] = 'ok'
            except Exception as e:  # one failing backend must not stop the others
                results[name] = f'error: {e}'
    _log(sd, {'ts': time.strftime('%Y-%m-%dT%H:%M:%S'), 'event': n.event, 'agent': n.agent,
              'project': n.project, 'sent': ok, 'reason': why, 'results': results})
    return ok, why, results
