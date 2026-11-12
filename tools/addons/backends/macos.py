"""Native macOS notifications. No third-party Python packages."""
import json, shutil, subprocess
NAME = 'macos'
def available(cfg):
    return (bool(shutil.which('osascript')), 'osascript not available')
def send(n, cfg):
    script = 'display notification ' + json.dumps(n.short()) + ' with title ' + json.dumps(n.heading())
    subprocess.run(['osascript', '-e', script], check=True, timeout=10, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
