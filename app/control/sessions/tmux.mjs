// tmux through execFile (never a shell). Binary and server socket are injectable:
//   makeTmux({ bin: 'tmux', socketName: 't55-123' })  -> tmux -L t55-123 ...
//   makeTmux({ socketPath: '/tmp/x.sock' })            -> tmux -S /tmp/x.sock ...
// Production uses the default server (no -L/-S), which is where the owner's sessions live.
import { execFile } from 'node:child_process';

export function makeTmux({ bin = process.env.TMUX_BIN || 'tmux', socketName = process.env.CONTROL_TMUX_L || null, socketPath = process.env.CONTROL_TMUX_S || null, timeout = 5000 } = {}) {
  const base = socketPath ? ['-S', socketPath] : socketName ? ['-L', socketName] : [];
  function run(args, input) {
    return new Promise((ok, fail) => {
      const env = { ...process.env }; delete env.TMUX; // talk to the chosen server, not the one we may run inside
      const ch = execFile(bin, [...base, ...args], { timeout, maxBuffer: 8 << 20, env }, (err, so, se) => {
        if (err) { err.stderr = String(se || ''); return fail(err); }
        ok(String(so));
      });
      if (input != null) { ch.stdin.end(input); }
    });
  }
  const FMT = '#{pane_id}\t#{pane_pid}\t#{session_name}\t#{window_id}\t#{window_index}\t#{pane_index}\t#{pane_current_command}\t#{pane_tty}';
  async function listPanes() {
    let out = ''; try { out = await run(['list-panes', '-a', '-F', FMT]); } catch { return []; }
    return out.split('\n').filter(Boolean).map((l) => {
      const [id, pid, session, windowId, win, pane, cmd, tty] = l.split('\t');
      return { id, pid: Number(pid), session, windowId, target: `${session}:${win}.${pane}`, cmd, tty };
    });
  }
  const capture = (pane, { lines = 200, escapes = true } = {}) => run(['capture-pane', '-p', ...(escapes ? ['-e'] : []), '-J', '-S', `-${lines}`, '-t', pane]);
  // bracketed paste of `text`, then Enter: load-buffer - ; paste-buffer -p -d ; send-keys Enter
  async function paste(pane, text, { enter = true } = {}) {
    const name = `ctl-${process.pid}-${Date.now().toString(36)}`;
    await run(['load-buffer', '-b', name, '-'], text);
    await run(['paste-buffer', '-p', '-d', '-b', name, '-t', pane]);
    if (enter) await run(['send-keys', '-t', pane, 'Enter']);
  }
  const sendKeys = (pane, keys, { literal = false } = {}) => run(['send-keys', '-t', pane, ...(literal ? ['-l'] : []), ...[].concat(keys)]);
  const hasSession = (name) => run(['has-session', '-t', `=${name}`]).then(() => true, () => false);
  const newSession = (name, cwd) => run(['new-session', '-d', '-s', name, ...(cwd ? ['-c', cwd] : [])]);
  async function newWindow(session, name, cwd, argv) {
    const out = await run(['new-window', '-d', '-P', '-F', '#{pane_id}\t#{pane_pid}', '-t', `${session}:`, '-n', name, '-c', cwd, '--', ...argv]);
    const [paneId, panePid] = out.trim().split('\t');
    return { paneId, panePid: Number(panePid) };
  }
  return { run, base, listPanes, capture, paste, sendKeys, hasSession, newSession, newWindow };
}

// keys the page may send (typed keys in the Terminal tab and prompt options). Anything else is refused.
export const NAMED_KEYS = new Set(['Enter', 'BSpace', 'Escape', 'Up', 'Down', 'Left', 'Right', 'Tab', 'BTab', 'C-c', 'Home', 'End', 'PageUp', 'PageDown', 'DC', 'Space', 'y', 'n']);
export function validKey(k) {
  if (typeof k !== 'object' || !k) return false;
  if (k.key) return NAMED_KEYS.has(k.key);
  if (typeof k.text === 'string') return k.text.length > 0 && k.text.length <= 64 && !/[\x00-\x1f\x7f]/.test(k.text);
  return false;
}
