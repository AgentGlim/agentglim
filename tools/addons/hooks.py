"""Turn Claude Code hook input and Codex `notify` payloads into Notifications."""
import glob, json, os
from datetime import datetime, timezone
from pathlib import Path

from notify_core import Notification

AGENTS = {'claude': 'Claude Code', 'codex': 'Codex', 'pi': 'Pi', 'opencode': 'OpenCode'}


def _ts(s):
    try:
        return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()
    except (AttributeError, ValueError):
        return None


def _iter_reversed_lines(path, chunk=1 << 20):
    with open(path, 'rb') as f:
        f.seek(0, os.SEEK_END)
        pos, rest = f.tell(), b''
        while pos > 0:
            step = min(chunk, pos)
            pos -= step
            f.seek(pos)
            data = f.read(step) + rest
            lines = data.split(b'\n')
            rest = lines[0]
            for line in reversed(lines[1:]):
                if line.strip():
                    yield line
        if rest.strip():
            yield rest


def _claude_text(rec):
    content = (rec.get('message') or {}).get('content')
    if isinstance(content, list):
        if any(isinstance(c, dict) and c.get('type') == 'tool_result' for c in content):
            return None
        content = ' '.join(c.get('text', '') for c in content if isinstance(c, dict))
    return content if isinstance(content, str) else None


def _claude_is_prompt(rec):
    """A prompt you typed (not a tool result, meta row, slash-command output or background-job notice)."""
    if rec.get('type') != 'user' or rec.get('isMeta') or rec.get('isCompactSummary'):
        return False
    content = _claude_text(rec)
    if not content or not content.strip():
        return False
    return not any(t in content for t in ('<local-command-stdout>', '<local-command-caveat>', '<task-notification>'))


def _bg_launches(rec):
    """Background jobs an assistant row starts (Bash run_in_background, Agent, Workflow)."""
    if rec.get('type') != 'assistant':
        return 0
    n = 0
    for c in (rec.get('message') or {}).get('content') or []:
        if not isinstance(c, dict) or c.get('type') != 'tool_use':
            continue
        name, inp = c.get('name'), c.get('input') or {}
        if name == 'Bash' and inp.get('run_in_background'):
            n += 1
        elif name in ('Agent', 'Task') and inp.get('run_in_background') is not False:
            n += 1
        elif name == 'Workflow':
            n += 1
    return n


def claude_turn(transcript_path):
    """(time of the last prompt you typed, background jobs started since then and not yet reported done).

    Background-job notices re-invoke Claude without you typing, so they do not start a new turn:
    a job is "finished" when everything it kicked off has come back."""
    launched = done = 0
    try:
        for line in _iter_reversed_lines(transcript_path):
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if _claude_is_prompt(rec):
                return _ts(rec.get('timestamp')), max(0, launched - done)
            launched += _bg_launches(rec)
            if rec.get('type') == 'user' and '<task-notification>' in (_claude_text(rec) or ''):
                done += 1
    except OSError:
        pass
    return None, 0


def last_prompt_time_claude(transcript_path):
    """Timestamp of the last prompt you typed in a Claude Code transcript (None if unknown)."""
    return claude_turn(transcript_path)[0]


def codex_rollout(thread_id, home=None):
    home = Path(home or os.environ.get('CODEX_HOME', Path.home() / '.codex'))
    hits = glob.glob(str(home / 'sessions' / '*' / '*' / '*' / f'rollout-*{thread_id}.jsonl'))
    return max(hits, key=os.path.getmtime) if hits else None


def last_prompt_time_codex(path):
    fallback = None
    try:
        for line in _iter_reversed_lines(path):
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            p = rec.get('payload') or {}
            if rec.get('type') == 'event_msg' and p.get('type') == 'user_message':
                return _ts(rec.get('timestamp'))
            if fallback is None and rec.get('type') == 'response_item' and p.get('role') == 'user':
                text = json.dumps(p.get('content', ''))
                if '<environment_context>' not in text and 'AGENTS.md' not in text:
                    fallback = _ts(rec.get('timestamp'))
    except OSError:
        pass
    return fallback


def _proc(pid):
    try:
        stat = Path(f'/proc/{pid}/stat').read_text()
        ppid = int(stat.rsplit(')', 1)[1].split()[1])
        comm = Path(f'/proc/{pid}/comm').read_text().strip()
        args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        return ppid, comm, [a.decode('utf-8', 'replace') for a in args if a]
    except (OSError, ValueError, IndexError):
        return None


def find_agent(pid=None):
    """Walk up the process tree. Returns (agent key, headless?) or (None, False)."""
    pid = pid or os.getppid()
    for _ in range(15):
        info = _proc(pid)
        if not info:
            break
        ppid, comm, args = info
        name = os.path.basename(args[0]) if args else comm
        for key in AGENTS:
            if comm == key or name == key:
                rest = args[1:]
                headless = {
                    'claude': '-p' in rest or '--print' in rest,
                    'codex': bool(rest) and rest[0] in ('exec', 'e'),
                    'pi': '-p' in rest or '--print' in rest,
                    'opencode': bool(rest) and rest[0] == 'run',
                }[key]
                return key, headless
        if ppid <= 1:
            break
        pid = ppid
    return None, False


def minutes(sec):
    m = int(sec // 60)
    return f'{m} min' if m < 90 else f'{m // 60} h {m % 60} min'


def from_claude(data, cfg, now=None):
    """Claude Code hook input -> (Notification | None, reason)."""
    now = now or datetime.now(timezone.utc).timestamp()
    ev = data.get('hook_event_name')
    project = Path(data.get('cwd') or os.getcwd()).name
    mk = lambda e, msg: Notification(e, msg, agent='Claude Code', project=project)
    if ev == 'Notification':
        if data.get('notification_type') in ('permission_prompt', 'elicitation_dialog'):
            return mk('needs_input', data.get('message') or 'Claude is waiting for your approval.'), 'ok'
        return None, f"notification type {data.get('notification_type')} ignored"
    if ev == 'PreToolUse' and data.get('tool_name') == 'AskUserQuestion':
        qs = (data.get('tool_input') or {}).get('questions') or []
        q = qs[0].get('question') if qs and isinstance(qs[0], dict) else ''
        more = f' (+{len(qs) - 1} more)' if len(qs) > 1 else ''
        return mk('needs_input', (q or 'Claude has a question for you.') + more), 'ok'
    if ev == 'PreToolUse' and data.get('tool_name') == 'ExitPlanMode':
        return mk('needs_input', 'Plan ready for your review.'), 'ok'
    if ev == 'Stop':
        start, pending = claude_turn(data.get('transcript_path') or '')
        if start is None:
            return None, 'turn start unknown'
        if pending:
            return None, f'{pending} background job(s) still running; kicked off, not finished'
        took = now - start
        if took < cfg['finished_min_minutes'] * 60:
            return None, f'turn took {int(took)}s, under threshold'
        last = (data.get('last_assistant_message') or '').strip().splitlines()
        return mk('finished', f"Done after {minutes(took)}. {last[0] if last else ''}".strip()), 'ok'
    return None, f'hook {ev} ignored'


def from_codex(payload, cfg, now=None):
    """Codex notify payload -> (Notification | None, reason)."""
    now = now or datetime.now(timezone.utc).timestamp()
    if payload.get('type') != 'agent-turn-complete':
        return None, f"codex event {payload.get('type')} ignored"
    project = Path(payload.get('cwd') or os.getcwd()).name
    path = codex_rollout(payload.get('thread-id', '')) if payload.get('thread-id') else None
    start = last_prompt_time_codex(path) if path else None
    if start is None:
        return None, 'turn start unknown'
    took = now - start
    if took < cfg['finished_min_minutes'] * 60:
        return None, f'turn took {int(took)}s, under threshold'
    last = (payload.get('last-assistant-message') or '').strip().splitlines()
    return Notification('finished', f"Done after {minutes(took)}. {last[0] if last else ''}".strip(),
                        agent='Codex', project=project), 'ok'
