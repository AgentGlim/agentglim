"""Windows toast, sent from WSL (or Windows) through Windows PowerShell 5.1. No modules needed.

Known agents get their own app identity (name + logo in the toast header, and their own entry in
Windows notification settings) through a per-user AppUserModelId registry key. Anything else, or
any failure setting that up, falls back to PowerShell's own identity.
"""
import base64, shutil, subprocess
from pathlib import Path
from xml.sax.saxutils import escape

NAME = 'windows'
# PowerShell's own AppUserModelID: lets an unregistered script show toasts.
PS_APP_ID = r'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
PS_PATHS = ['powershell.exe', '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe']
ICONS = Path(__file__).resolve().parents[1] / 'icons'
# agent name -> (app id, header icon in icons/)
APPS = {
    'Claude Code': ('AgentNotify.ClaudeCode', 'claude'),
    'Codex': ('AgentNotify.Codex', 'codex'),
    'Pi': ('AgentNotify.Pi', 'pi'),
}
ICON_DIR = '__ICONDIR__'  # replaced inside PowerShell with %LOCALAPPDATA%\agent-notify\icons

SCRIPT = r'''$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$appId = '__APPID__'
$x = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__XML__'))
$files = @(__FILES__)
try {
  $dir = Join-Path $env:LOCALAPPDATA 'agent-notify\icons'
  foreach ($f in $files) {
    $s = Join-Path '__SRC__' $f; $t = Join-Path $dir $f
    if (-not (Test-Path $t) -or (Get-Item $s).Length -ne (Get-Item $t).Length) {
      New-Item -ItemType Directory -Force $dir | Out-Null; Copy-Item $s $t -Force }
  }
  if ($appId -like 'AgentNotify.*') {
    $k = "HKCU:\Software\Classes\AppUserModelId\$appId"; $icon = Join-Path $dir '__HEADICON__'
    $p = Get-ItemProperty $k -ErrorAction SilentlyContinue
    if ($p.DisplayName -ne '__NAME__' -or $p.IconUri -ne $icon) {
      New-Item $k -Force | Out-Null
      New-ItemProperty $k -Name DisplayName -Value '__NAME__' -PropertyType String -Force | Out-Null
      New-ItemProperty $k -Name IconUri -Value $icon -PropertyType String -Force | Out-Null }
  }
  $x = $x.Replace('__ICONDIR__', $dir)
} catch {
  $appId = '__PSAPPID__'
  $x = [regex]::Replace($x, '<image [^>]*/>', '')
}
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($x)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = '__TAG__'
$toast.Group = 'agent-notify'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
'''


def _ps():
    for p in PS_PATHS:
        if shutil.which(p):
            return shutil.which(p)
    return None


def available(cfg):
    return (True, '') if _ps() else (False, 'powershell.exe not found (not on Windows/WSL?)')


def identity(n, cfg):
    """(app id, display name, header icon, logo inside the toast) for this ping."""
    if not cfg.get('windows', {}).get('agent_logos', True) or n.agent not in APPS:
        return PS_APP_ID, '', '', ''
    app_id, head = APPS[n.agent]
    logo = cfg.get('logos', {}).get(n.agent, head)
    if logo and not (ICONS / f'{logo}.png').exists():
        logo = ''
    return app_id, n.agent, f'{head}.png', logo


def toast_xml(n, logo=''):
    audio = {'high': '<audio src="ms-winsoundevent:Notification.Reminder"/>',
             'low': '<audio silent="true"/>'}.get(n.urgency, '<audio src="ms-winsoundevent:Notification.Default"/>')
    attrib = escape(' - '.join(x for x in (n.agent, n.project) if x))
    # High-urgency pings use the reminder scenario: they stay on screen until dismissed.
    sticky = n.urgency == 'high'
    head = '<toast scenario="reminder">' if sticky else '<toast>'
    actions = ('<actions><action content="Dismiss" arguments="dismiss" activationType="system"/></actions>'
               if sticky else '')
    image = f'<image placement="appLogoOverride" src="{ICON_DIR}\\{logo}.png"/>' if logo else ''
    return (f'{head}<visual><binding template="ToastGeneric">'
            f'<text>{escape(n.heading())}</text><text>{escape(n.short())}</text>'
            f'<text placement="attribution">{attrib}</text>{image}'
            f'</binding></visual>{actions}{audio}</toast>')


def _win_path(p):
    try:
        r = subprocess.run(['wslpath', '-w', str(p)], capture_output=True, text=True, timeout=5)
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    return str(p)


def _ps_str(s):
    return s.replace("'", "''")


def build_command(n, cfg=None):
    app_id, name, head_icon, logo = identity(n, cfg or {})
    files = sorted({f for f in (head_icon, f'{logo}.png' if logo else '') if f})
    xml_b64 = base64.b64encode(toast_xml(n, logo).encode('utf-8')).decode()
    script = (SCRIPT.replace('__XML__', xml_b64).replace('__TAG__', n.event[:60])
              .replace('__APPID__', app_id).replace('__PSAPPID__', PS_APP_ID)
              .replace('__NAME__', _ps_str(name)).replace('__HEADICON__', head_icon)
              .replace('__FILES__', ', '.join(f"'{f}'" for f in files))
              .replace('__SRC__', _ps_str(_win_path(ICONS)) if files else ''))
    enc = base64.b64encode(script.encode('utf-16-le')).decode()
    return [_ps() or 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc]


def send(n, cfg):
    r = subprocess.run(build_command(n, cfg), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout).strip().splitlines()[-1] if (r.stderr or r.stdout).strip() else f'exit {r.returncode}')
