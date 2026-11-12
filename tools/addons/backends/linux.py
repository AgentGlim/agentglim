"""Linux desktop notification via notify-send (Debian: sudo apt install libnotify-bin)."""
import os, shutil, subprocess
from pathlib import Path

NAME = 'linux'
ICONS = Path(__file__).resolve().parents[1] / 'icons'
URGENCY = {'high': 'critical', 'normal': 'normal', 'low': 'low'}


def available(cfg):
    if not shutil.which('notify-send'):
        return False, 'notify-send missing; run: sudo apt install libnotify-bin'
    bus = os.environ.get('DBUS_SESSION_BUS_ADDRESS') or os.path.exists(f"{os.environ.get('XDG_RUNTIME_DIR', '')}/bus")
    if not bus:
        return False, 'no desktop session bus (headless or SSH session)'
    return True, ''


def build_command(n, cfg=None):
    logo = (cfg or {}).get('logos', {}).get(n.agent, '')
    icon = ICONS / f'{logo}.png' if logo else None
    return ['notify-send', f'--app-name={n.agent if logo else "agent-notify"}', f'--urgency={URGENCY.get(n.urgency, "normal")}',
            f'--icon={icon if icon and icon.exists() else "dialog-information"}', n.heading(), n.short()]


def send(n, cfg):
    r = subprocess.run(build_command(n, cfg), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or f'exit {r.returncode}')
